/**
 * 服务端转码（ffmpeg → HLS）路由。
 *
 * 用途：iPhone Safari（iOS < 17.1）等不支持 MediaSource 的浏览器无法运行
 * 浏览器端重封装/转码管线，改由服务端 ffmpeg 把影片源流转成 HLS 分片，
 * 前端用 hls.js（或 iOS Safari 原生 HLS 播放器）直接播放。
 *
 * 端点（全部需要登录态，媒体请求可带 `?token=`）：
 * - GET    /api/transcode/capability              探测本机 ffmpeg 是否可用
 * - POST   /api/transcode/session                 创建/复用转码会话，返回 playlistUrl
 * - GET    /api/transcode/:sessionId/index.m3u8   等待并返回播放列表（URI 已改写为绝对地址）
 * - GET    /api/transcode/:sessionId/:segment     返回 fmp4 分片 / init.mp4（支持 Range）
 * - DELETE /api/transcode/:sessionId              立即停止并清理会话
 *
 * 关键设计：
 * - ffmpeg 的输入不是影片直链，而是本项目自己的 `/api/<source>/stream` 端点——
 *   这样 WebDAV/OpenList/FTP/Emby/Jellyfin 的凭证、防盗链、网盘 cookie 全部由
 *   既有代码处理，转码模块不需要再实现一遍源适配。
 * - 该内部请求需要鉴权，故服务端用 `generateTokens` 为当前用户现签一个短期
 *   access token 拼进内部 URL（auth 中间件接受 `?token=`）。
 * - 分片/播放列表端点由浏览器反复拉取，因此 sessionKey 相同的重复请求复用同一个
 *   ffmpeg 进程，空闲 15 分钟才回收。
 */
import { Router, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import {
  authenticateToken,
  generateTokens,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  createSession,
  getSession,
  stopSession,
  touchSession,
  type TranscodeMode,
  type TranscodeSession,
} from '../services/transcode/session';
import { getFfmpegVersion, resolveFfmpegPath } from '../services/transcode/ffmpeg';

const router = Router();

// 全部端点需登录：播放列表/分片由 hls.js 拉取，无法带 Authorization 头，
// 因此前端会把 access token 拼进 query（authenticateToken 支持 ?token=）。
router.use(authenticateToken);

/** 支持服务端转码的挂载源：均有 /api/<source>/stream?movieId= 代理端点。 */
const MOUNT_SOURCES = ['webdav', 'openlist', 'ftp', 'emby', 'jellyfin'];

/** 播放列表等待上限：ffmpeg 启动 + 探测源 + 写出 m3u8 通常 < 3s，20s 足够容忍慢源。 */
const PLAYLIST_WAIT_TIMEOUT_MS = 20 * 1000;

/** 播放列表轮询间隔。 */
const PLAYLIST_POLL_INTERVAL_MS = 250;

/** 回给前端的 ffmpeg stderr 摘要长度上限（只保留尾部，最关键的信息在最后几行）。 */
const ERROR_MESSAGE_MAX = 800;

/** HLS 播放列表 MIME。 */
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** fmp4 分片 MIME。 */
const FMP4_SEGMENT_CONTENT_TYPE = 'video/iso.segment';

/** init.mp4 等 MP4 文件 MIME。 */
const MP4_CONTENT_TYPE = 'video/mp4';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 截断保留尾部（错误信息的关键内容通常在最后几行）。 */
function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

/** 把会话收集到的 stderr 尾部拼成一行诊断文本。 */
function formatErrorTail(session: TranscodeSession): string {
  const tail =
    session.errorTail.length > 0 ? session.errorTail.join(' | ') : '（ffmpeg 无 stderr 输出）';
  return truncateTail(tail, ERROR_MESSAGE_MAX);
}

/** 相对 URI → 绝对分片地址（保留播放列表请求携带的查询串，如 ?token=）。 */
function toSegmentUrl(uri: string, sessionId: string, query: string): string {
  const clean = uri.trim();
  // 空值或已是绝对地址（http(s):、data: 等）：保持原样
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return uri;
  const name = path.posix.basename(clean.split('?')[0].split('#')[0].replace(/\\/g, '/'));
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return uri;
  return `/api/transcode/${sessionId}/${name}${query}`;
}

/**
 * 改写播放列表中的相对 URI 为绝对路径。
 *
 * 为什么必须改写：hls.js / Safari 解析相对 URI 时不会继承播放列表 URL 的查询串，
 * 而分片端点同样需要 `?token=` 鉴权，不改写会出现「列表能加载、分片全 401」。
 * 注意 fmp4 的初始化分片写在 `#EXT-X-MAP:URI="init.mp4"` 标签内，也要一起改写。
 */
function rewritePlaylist(content: string, sessionId: string, query: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const mapMatched = /^(#EXT-X-MAP:[^"]*URI=")([^"]*)(".*)$/.exec(trimmed);
      if (mapMatched) {
        return `${mapMatched[1]}${toSegmentUrl(mapMatched[2], sessionId, query)}${mapMatched[3]}`;
      }
      if (trimmed.startsWith('#')) return line;
      return toSegmentUrl(trimmed, sessionId, query);
    })
    .join('\n');
}

/**
 * 提取并规范化播放列表请求携带的查询串。
 *
 * 走 URLSearchParams 往返一次：既原样保留 token 等参数（只是重新编码），
 * 又天然挡掉 CRLF / 引号注入（会被百分号转义），避免污染 m3u8 正文。
 */
function normalizeQuery(originalUrl: string): string {
  const idx = originalUrl.indexOf('?');
  if (idx < 0) return '';
  const raw = originalUrl.slice(idx + 1);
  if (!raw) return '';
  try {
    const normalized = new URLSearchParams(raw).toString();
    return normalized ? `?${normalized}` : '';
  } catch {
    return '';
  }
}

/** 只读文件头部若干字节（轮询时避免反复整读播放列表）。 */
async function readHead(file: string, length: number): Promise<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** 播放列表是否已可用：#EXTM3U 头已写出（ffmpeg 先建文件再写内容）。 */
async function isPlaylistReady(file: string): Promise<boolean> {
  try {
    return (await readHead(file, 16)).startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

type PlaylistWaitResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * 轮询等待播放列表可读：最多 20s，250ms 一次。
 * ffmpeg 失败/已退出但没产物 → 立刻失败并把 stderr 尾部带回给前端。
 */
async function waitForPlaylist(session: TranscodeSession): Promise<PlaylistWaitResult> {
  const deadline = Date.now() + PLAYLIST_WAIT_TIMEOUT_MS;
  for (;;) {
    if (await isPlaylistReady(session.playlistPath)) return { ok: true };
    if (session.failed) {
      return {
        ok: false,
        code: 'FFMPEG_FAILED',
        message: `服务端转码失败：${formatErrorTail(session)}`,
      };
    }
    if (session.finished) {
      return {
        ok: false,
        code: 'FFMPEG_EXITED',
        message: `转码进程已退出但未生成播放列表：${formatErrorTail(session)}`,
      };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        code: 'TIMEOUT',
        message: `等待转码播放列表超时（${PLAYLIST_WAIT_TIMEOUT_MS / 1000}s）：${formatErrorTail(session)}`,
      };
    }
    await sleep(PLAYLIST_POLL_INTERVAL_MS);
  }
}

/** 内部请求地址拼接：path 已带查询串时用 &，否则用 ?。 */
function appendQuery(url: string, query: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

/** 解析正数（用于 movieId / start），非法返回 null。 */
function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

// ==================== GET /capability ====================
// 前端在决定是否走服务端转码前先探测一次：没有 ffmpeg 就直接退回浏览器端管线。
router.get('/capability', async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) {
      res.json({ success: true, available: false, version: null });
      return;
    }
    const version = await getFfmpegVersion();
    res.json({ success: true, available: true, version });
  } catch (err) {
    console.error('[transcode] capability error:', err);
    res.json({ success: true, available: false, version: null });
  }
});

// ==================== POST /session ====================
// body: { movieId: number, mode?: 'remux' | 'transcode', start?: number }
router.post('/session', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as { movieId?: unknown; mode?: unknown; start?: unknown };

    const movieId = parsePositiveNumber(body.movieId);
    if (movieId === null) {
      res.status(400).json({ success: false, message: '缺少或不正确的 movieId' });
      return;
    }

    // 模式缺省按 remux（只换容器，几乎不耗 CPU）
    const mode: TranscodeMode = body.mode === 'transcode' ? 'transcode' : 'remux';
    const start = parsePositiveNumber(body.start) ?? 0;

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    // 内部输入地址：指向本项目自己的流代理端点，
    // 由既有代码处理 WebDAV/OpenList/FTP/Emby/Jellyfin/服务器文件的凭证与防盗链。
    const source = (movie.source || '').trim();
    let inputPath: string;
    if (MOUNT_SOURCES.includes(source)) {
      inputPath = `/api/${source}/stream?movieId=${movie.id}`;
    } else if (source === 'server-files') {
      if (!movie.path) {
        res.status(400).json({ success: false, message: '影片缺少文件路径，无法服务端转码' });
        return;
      }
      inputPath = `/api/server-files/proxy?path=${encodeURIComponent(movie.path)}`;
    } else {
      res.status(400).json({ success: false, message: '该来源不支持服务端转码' });
      return;
    }

    // ffmpeg 缺失 → 明确告知前端，退回浏览器端管线或提示用户安装
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) {
      res.status(503).json({
        success: false,
        code: 'FFMPEG_MISSING',
        message:
          '服务端未安装 ffmpeg，无法使用服务端转码（请安装 ffmpeg 或设置 FFMPEG_PATH 环境变量）',
      });
      return;
    }

    // 为内部请求现签一个短期 access token（内部 URL 走同一套鉴权中间件）
    const user = req.user;
    if (!user) {
      res.status(401).json({ success: false, message: '未提供认证令牌' });
      return;
    }
    const { accessToken } = generateTokens(user.userId, user.role, user.username);

    const base = `http://127.0.0.1:${process.env.PORT || 3333}`;
    const inputUrl = `${base}${appendQuery(inputPath, `token=${encodeURIComponent(accessToken)}`)}`;

    const session = await createSession({
      inputUrl,
      mode,
      startTime: start,
      sessionKey: `${movie.id}:${mode}:${start}`,
    });

    res.json({
      success: true,
      sessionId: session.id,
      playlistUrl: `/api/transcode/${session.id}/index.m3u8`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'FFMPEG_MISSING') {
      res.status(503).json({
        success: false,
        code: 'FFMPEG_MISSING',
        message:
          '服务端未安装 ffmpeg，无法使用服务端转码（请安装 ffmpeg 或设置 FFMPEG_PATH 环境变量）',
      });
      return;
    }
    console.error('[transcode] create session error:', err);
    res.status(500).json({ success: false, message: '创建转码会话失败' });
  }
});

// ==================== GET /:sessionId/index.m3u8 ====================
router.get(
  '/:sessionId/index.m3u8',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const sessionId = String(req.params.sessionId ?? '');
    const session = getSession(sessionId);
    if (!session) {
      res.status(404).json({ success: false, message: '转码会话不存在或已过期' });
      return;
    }

    try {
      const ready = await waitForPlaylist(session);
      if (!ready.ok) {
        res.status(502).json({ success: false, code: ready.code, message: ready.message });
        return;
      }

      const content = await fsp.readFile(session.playlistPath, 'utf8');
      // 分片地址带上客户端本次请求的查询串（含 ?token=）
      const body = rewritePlaylist(content, sessionId, normalizeQuery(req.originalUrl));

      touchSession(sessionId);
      // 注意用 res.end 而非 res.send：res.send(string) 会给 Content-Type 追加
      // `; charset=utf-8`，而 HLS 播放列表按标准应保持纯净的
      // application/vnd.apple.mpegurl（部分播放器对 MIME 参数较敏感）
      res.setHeader('Content-Type', PLAYLIST_CONTENT_TYPE);
      res.setHeader('Content-Length', Buffer.byteLength(body));
      // 播放列表随转码不断增长，禁止缓存，避免 hls.js 拿到旧列表不再刷新
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      console.error(`[transcode] 读取播放列表失败（会话 ${sessionId}）：`, err);
      res.status(500).json({ success: false, message: '读取转码播放列表失败' });
    }
  },
);

// ==================== GET /:sessionId/:segment ====================
// 只放行 ffmpeg 产物：<...>.m4s 分片与 init.mp4（或其它 .mp4）
router.get('/:sessionId/:segment', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const sessionId = String(req.params.sessionId ?? '');
  const segment = String(req.params.segment ?? '');

  if (!/^[A-Za-z0-9._-]+$/.test(segment) || !/\.(m4s|mp4)$/i.test(segment)) {
    res.status(400).json({ success: false, message: '非法的分片名' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ success: false, message: '转码会话不存在或已过期' });
    return;
  }

  // 防目录穿越：请求名必须是纯文件名，解析后仍须落在会话目录内
  const sessionDir = path.resolve(session.dir);
  const target = path.resolve(sessionDir, segment);
  if (path.basename(segment) !== segment || path.dirname(target) !== sessionDir) {
    res.status(400).json({ success: false, message: '非法的分片名' });
    return;
  }

  // 分片可能尚未写出（例如列表刚更新、客户端预取），此时回 404 让客户端稍后重试
  if (!fs.existsSync(target)) {
    res.status(404).json({ success: false, message: '分片不存在' });
    return;
  }

  touchSession(sessionId);
  const contentType = segment.toLowerCase().endsWith('.m4s')
    ? FMP4_SEGMENT_CONTENT_TYPE
    : MP4_CONTENT_TYPE;

  // 先设好 Content-Type：send 只在未设置时才按扩展名推断（.m4s 不在标准 MIME 表内）
  res.setHeader('Content-Type', contentType);
  // sendFile 走 express/send，自动处理 Range 请求（206 / Content-Range / 416）与 ETag 协商缓存
  res.sendFile(target, (err) => {
    if (!err) return;
    const code = (err as NodeJS.ErrnoException).code;
    // 客户端主动断开（拖动进度条时 hls.js 会 abort）不是错误
    if (code === 'ECONNABORTED' || code === 'EPIPE' || res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (code === 'ENOENT') {
      res.status(404).json({ success: false, message: '分片不存在' });
      return;
    }
    console.error(`[transcode] 发送分片失败（${target}）：`, err);
    res.status(500).json({ success: false, message: '读取转码分片失败' });
  });
});

// ==================== DELETE /:sessionId ====================
// 前端离开播放页/切换影片时主动释放 ffmpeg 与磁盘分片
router.delete('/:sessionId', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const sessionId = String(req.params.sessionId ?? '');
  try {
    const stopped = await stopSession(sessionId);
    if (!stopped) {
      res.status(404).json({ success: false, message: '转码会话不存在或已过期' });
      return;
    }
    console.log(`[transcode] 已停止会话 ${sessionId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[transcode] 停止会话失败（${sessionId}）：`, err);
    res.status(500).json({ success: false, message: '停止转码会话失败' });
  }
});

export default router;
