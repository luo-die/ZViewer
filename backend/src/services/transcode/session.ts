/**
 * 服务端 HLS 转码会话管理。
 *
 * 背景：iPhone Safari（iOS < 17.1）等没有 MediaSource 的浏览器无法运行
 * 浏览器端重封装/转码管线，只能由服务端 ffmpeg 把源流转成 HLS，
 * 再由 hls.js / Safari 原生 HLS 播放器播放（无需 MSE）。
 *
 * 会话模型：
 * - 一次「影片 + 模式 + 起点」对应一个会话（Map 按 sessionKey 去重），
 *   hls.js 反复请求 index.m3u8、或同一房间多人同时观看时不会重复拉起 ffmpeg；
 * - 输出目录 `<CONFIG_DIR>/transcode/<sessionId>/`，内含 `index.m3u8`、
 *   `init.mp4`、`seg00001.m4s` ...（fmp4 分片，URI 全部保持相对路径，由路由层改写为绝对地址）；
 * - ffmpeg 以 argv 数组方式 spawn（绝不拼 shell 字符串），避免 URL 中的
 *   `&`、`?`、空格等字符被 shell 解释；
 * - stderr 只保留最后若干行在内存中（诊断用），不落盘、不刷日志，避免大文件转码把日志撑爆。
 *
 * 生命周期：
 * - `createSession()` 创建/复用会话；
 * - 路由层每次访问播放列表/分片调用 `touchSession()` 续期；
 * - 模块内单个 2 分钟定时器（已 unref，不阻塞进程退出）回收 15 分钟无访问的会话，
 *   kill ffmpeg 并递归删除目录；
 * - 进程退出前调用 `disposeTranscodeSessions()`（内部即 `cleanupAll()`）清理全部会话。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_DIR } from '../paths';
import { resolveFfmpegPath } from './ffmpeg';

/** 转码模式：remux = 视频流直接 copy 重封装；transcode = libx264 真转码。 */
export type TranscodeMode = 'remux' | 'transcode';

export interface TranscodeSession {
  /** 会话 ID（16 位十六进制随机串，同时作为目录名与 URL 片段）。 */
  id: string;
  /** 去重键：`<movieId>:<mode>:<start>`，同键会话复用同一个 ffmpeg 进程。 */
  sessionKey: string;
  /** 会话输出目录（绝对路径）。 */
  dir: string;
  /** 播放列表绝对路径（`<dir>/index.m3u8`）。 */
  playlistPath: string;
  /** ffmpeg 子进程；已退出/启动失败时为 null。 */
  process: ChildProcess | null;
  mode: TranscodeMode;
  /** 相对源文件的起点（秒），0 表示从头开始。 */
  startTime: number;
  /** 创建时间戳（毫秒）。 */
  createdAt: number;
  /** 最近一次被访问的时间戳（毫秒），空闲回收依据。 */
  lastAccessAt: number;
  /** ffmpeg 进程是否已结束（无论成功失败）。 */
  finished: boolean;
  /** 是否失败（非 0 退出码 / spawn 错误）。服务端主动 kill 不算失败。 */
  failed: boolean;
  /** 最近的 ffmpeg stderr 行（最多 STDERR_TAIL_LINES 行），用于 502 时回显诊断信息。 */
  errorTail: string[];
  /** ffmpeg stderr 原始缓冲（仅保留尾部 STDERR_BUFFER_MAX 字节），用于按行提取 errorTail。 */
  stderrBuffer: string;
  /** 是否已被服务端主动停止（主动停止不算失败，避免误报错误日志）。 */
  stopped: boolean;
}

export interface CreateSessionOptions {
  /** 已带鉴权 token 的源地址（本机 /api/<source>/stream 之类的 HTTP URL）。 */
  inputUrl: string;
  /** 转码模式，默认 remux。 */
  mode?: TranscodeMode;
  /** 起点（秒），> 0 时以 `-ss` 输入定位。 */
  startTime?: number;
  /** 去重键：调用方按「影片 + 模式 + 起点」生成。 */
  sessionKey: string;
}

/** 转码输出根目录：与其它运行时数据一起放在 config/ 下，升级时整体保留。 */
const TRANSCODE_ROOT = path.join(CONFIG_DIR, 'transcode');

/** 空闲回收阈值：15 分钟无任何分片/播放列表请求即回收。 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** 空闲扫描间隔：2 分钟一次（unref，不影响进程退出）。 */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

/** 诊断信息保留的 stderr 行数。 */
const STDERR_TAIL_LINES = 20;

/** stderr 原始缓冲上限（字节）：只需尾部诊断信息，避免长转码把内存吃满。 */
const STDERR_BUFFER_MAX = 8 * 1024;

/** 会话表：id → 会话。 */
const sessions = new Map<string, TranscodeSession>();
/** 去重表：sessionKey → id。 */
const sessionKeys = new Map<string, string>();
/** 空闲回收定时器（懒创建，首个会话建立时才启动）。 */
let cleanupTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起点归一化：非法/负数一律按 0 处理。 */
function normalizeStartTime(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 构造 ffmpeg argv（务必保持数组形式，禁止拼接 shell 字符串）。
 *
 * 参数要点：
 * - `-ss` 放在 `-i` 之前 = 输入定位，配合解码器关键帧定位，比输出定位快得多；
 *   未加 `-copyts` 时输出时间戳会从 0 重新开始，正是 HLS 从头播放所需的行为。
 * - `-c:v copy`（remux）只换容器不重编码，几乎零 CPU；`transcode` 用 libx264
 *   veryfast/crf23 保证实时性（服务端要一边转一边播，不能追求画质极限）。
 * - 音频一律转 AAC：DTS/AC3/EAC3/TrueHD 之类浏览器根本解不了，copy 出去等于没声音。
 * - `-max_muxing_queue_size 1024`：大码率源在 mux 阶段 packet 堆积，
 *   默认队列会导致 ffmpeg 直接报错中断。
 * - fmp4 分片：`-hls_segment_type fmp4` + 独立的 `init.mp4` 初始化分片。
 */
function buildArgs(params: {
  inputUrl: string;
  mode: TranscodeMode;
  startTime: number;
  dir: string;
  playlistPath: string;
}): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];

  // 输入定位：-ss 必须在 -i 之前
  if (params.startTime > 0) {
    args.push('-ss', String(params.startTime));
  }
  args.push('-i', params.inputUrl);

  if (params.mode === 'transcode') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }

  // 音频统一转 AAC（浏览器可解），双声道 192k
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  // 大源防 mux 队列溢出
  args.push('-max_muxing_queue_size', '1024');

  // HLS 输出：event 列表（只追加不删除，便于任意拖动已转出的部分）
  args.push(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(params.dir, 'seg%05d.m4s'),
    params.playlistPath,
  );

  return args;
}

/**
 * 日志用 argv 文本：把 `token=xxx` 打码，避免把鉴权 token 写进日志。
 * 仅用于 console 输出，spawn 始终使用原始数组。
 */
function formatArgsForLog(args: string[]): string {
  return args
    .map((arg) => arg.replace(/([?&]token=)[^&\s]+/gi, '$1***'))
    .join(' ');
}

/** 把 stderr 片段追加到会话缓冲，并刷新最近若干行。 */
function appendStderr(session: TranscodeSession, chunk: string): void {
  const merged = session.stderrBuffer + chunk;
  session.stderrBuffer =
    merged.length > STDERR_BUFFER_MAX ? merged.slice(merged.length - STDERR_BUFFER_MAX) : merged;
  session.errorTail = session.stderrBuffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES);
}

/** 结束 ffmpeg 进程（幂等）。SIGKILL 在 Windows 上等价于 TerminateProcess，可立即生效。 */
function killProcess(session: TranscodeSession): void {
  const child = session.process;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  session.stopped = true;
  try {
    child.kill('SIGKILL');
  } catch (err) {
    console.warn(
      `[transcode] 结束 ffmpeg 进程失败（会话 ${session.id}）：`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 等待子进程退出（最多 timeoutMs），用于删除目录前确认文件句柄已释放。 */
function waitForExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once('close', finish);
    child.once('error', finish);
  });
}

/**
 * 递归删除目录（带重试）。
 * Windows 下刚被 kill 的 ffmpeg 可能仍持有分片文件句柄，删除会 EBUSY/EPERM，
 * 短暂等待后重试即可；最终失败只告警，不影响会话回收。
 */
async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[transcode] 删除转码目录失败：${dir}`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      await sleep(200);
    }
  }
}

/** 懒启动空闲回收定时器（unref：不让定时器拖住进程退出）。 */
function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupIdleSessions();
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

/** 回收所有空闲超时的会话。 */
async function cleanupIdleSessions(): Promise<void> {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastAccessAt < IDLE_TIMEOUT_MS) continue;
    console.log(
      `[transcode] 会话 ${session.id} 空闲超过 ${Math.round(IDLE_TIMEOUT_MS / 60000)} 分钟，回收`,
    );
    await stopSession(session.id);
  }
}

/** 查找可复用的会话（仍在运行，或已转完且产出了播放列表）。 */
function findReusableSession(sessionKey: string): TranscodeSession | null {
  const id = sessionKeys.get(sessionKey);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) {
    sessionKeys.delete(sessionKey);
    return null;
  }
  if (session.failed) return null;
  // 仍在运行 → 直接复用（避免重复拉起 ffmpeg 抢带宽/CPU）
  if (session.process !== null && !session.finished) return session;
  // 已正常结束且播放列表存在 → 整片已转完，无需重跑
  if (session.finished && !session.stopped && fs.existsSync(session.playlistPath)) return session;
  return null;
}

/**
 * 用 ffprobe 判断源视频轨能否安全直通（remux），否则必须真转码。
 *
 * 背景（线上问题：切了服务端转码，安卓依旧只有声音没画面）：
 * 旧实现由前端按 `movie.videoCodec` 猜模式，而挂载类片源（WebDAV/OpenList/
 * FTP/Emby…）这个字段常年为空 → 猜成 remux → **HEVC 原样透传**，
 * 安卓/旧 iOS 依然解不了视频轨，症状与不开转码时一模一样。
 *
 * 判定规则（服务端转码的语义就是「兼容模式」，宁可多花 CPU 也要能播）：
 * - `h264` + `yuv420p`（8bit）→ copy 直通：几乎所有设备都能硬解，零 CPU；
 * - 其余（hevc / av1 / vp9 / 10bit / mpeg4 / 探测失败）→ libx264 重编码。
 *
 * ffprobe 只读文件头，通常几十毫秒；结果按输入地址缓存。
 */
const probeModeCache = new Map<string, TranscodeMode>();

async function decideModeForInput(inputUrl: string): Promise<TranscodeMode> {
  const cached = probeModeCache.get(inputUrl);
  if (cached) return cached;
  const result = await probeVideoCodec(inputUrl);
  // 探测不出信息时按「必须转码」处理：兼容优先，避免又回到 HEVC 直通的老坑
  const mode: TranscodeMode =
    result.codec === 'h264' && (!result.pixFmt || result.pixFmt === 'yuv420p')
      ? 'remux'
      : 'transcode';
  probeModeCache.set(inputUrl, mode);
  if (probeModeCache.size > 200) probeModeCache.clear();
  console.log(
    `[transcode] 源探测：codec=${result.codec ?? '-'} pix_fmt=${result.pixFmt ?? '-'} → ${mode}`,
  );
  return mode;
}

/** 调 ffprobe 读取首条视频轨的 codec_name / pix_fmt（失败返回空） */
async function probeVideoCodec(
  inputUrl: string,
): Promise<{ codec: string | null; pixFmt: string | null }> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return { codec: null, pixFmt: null };
  // ffprobe 与 ffmpeg 同目录（FFMPEG_PATH 指向 exe 时同样适用）
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  return await new Promise((resolve) => {
    let settled = false;
    const done = (value: { codec: string | null; pixFmt: string | null }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(
        ffprobePath,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,pix_fmt',
          '-of', 'json',
          inputUrl,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
        if (out.length > 64 * 1024) out = out.slice(0, 64 * 1024);
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done({ codec: null, pixFmt: null });
      }, 8000);
      child.on('error', () => {
        clearTimeout(timer);
        done({ codec: null, pixFmt: null });
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out) as {
            streams?: { codec_name?: string; pix_fmt?: string }[];
          };
          const stream = parsed.streams?.[0];
          done({
            codec: stream?.codec_name?.toLowerCase() ?? null,
            pixFmt: stream?.pix_fmt?.toLowerCase() ?? null,
          });
        } catch {
          done({ codec: null, pixFmt: null });
        }
      });
    } catch {
      done({ codec: null, pixFmt: null });
    }
  });
}

/**
 * 创建（或复用）一个 HLS 转码会话。
 *
 * @throws 当本机没有可用 ffmpeg 时抛出 message 为 `FFMPEG_MISSING` 的 Error。
 */
export async function createSession(opts: CreateSessionOptions): Promise<TranscodeSession> {
  // 显式指定则尊重；未指定 / 'auto' 时由 ffprobe 探测源编码决定
  // （源是 HEVC/AV1/10bit 必须真转码，否则安卓等设备仍只有声音没画面）
  const mode: TranscodeMode =
    opts.mode === 'transcode'
      ? 'transcode'
      : opts.mode === 'remux'
        ? 'remux'
        : await decideModeForInput(opts.inputUrl);
  const startTime = normalizeStartTime(opts.startTime);

  // 1. 复用：同一「影片 + 模式 + 起点」已有会话时直接返回
  const reused = findReusableSession(opts.sessionKey);
  if (reused) {
    reused.lastAccessAt = Date.now();
    console.log(
      `[transcode] 复用会话 ${reused.id}（${reused.mode}，起点 ${reused.startTime}s）`,
    );
    return reused;
  }

  // 2. 同 key 的历史会话已失败/无产物 → 先回收，避免目录与进程堆积
  const staleId = sessionKeys.get(opts.sessionKey);
  if (staleId) {
    await stopSession(staleId);
  }

  // 3. ffmpeg 必须可用（路由层已提前判断并返回 503，这里只是兜底）
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('FFMPEG_MISSING');
  }

  // 4. 建立输出目录
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TRANSCODE_ROOT, id);
  const playlistPath = path.join(dir, 'index.m3u8');
  await fsp.mkdir(dir, { recursive: true });

  const session: TranscodeSession = {
    id,
    sessionKey: opts.sessionKey,
    dir,
    playlistPath,
    process: null,
    mode,
    startTime,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    finished: false,
    failed: false,
    errorTail: [],
    stderrBuffer: '',
    stopped: false,
  };

  const args = buildArgs({ inputUrl: opts.inputUrl, mode, startTime, dir, playlistPath });
  const child = spawn(ffmpegPath, args, {
    // 不接 stdin（-nostdin 双保险）、不要 stdout、stderr 用管道收集诊断信息
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  session.process = child;

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => appendStderr(session, chunk));

  // spawn 本身失败（路径失效、权限不足）会以 error 事件抛出，而不是 throw
  child.on('error', (err) => {
    session.finished = true;
    session.failed = true;
    session.process = null;
    appendStderr(session, `[spawn error] ${err.message}`);
    console.error(`[transcode] 会话 ${id} 启动 ffmpeg 失败：`, err.message);
  });

  child.on('close', (code, signal) => {
    session.finished = true;
    session.process = null;
    if (session.stopped) {
      // 服务端主动停止（空闲回收 / DELETE），不算失败
      return;
    }
    if (code === 0) {
      console.log(`[transcode] 会话 ${id} 转码完成（${session.mode}）`);
      return;
    }
    session.failed = true;
    console.error(
      `[transcode] 会话 ${id} ffmpeg 异常退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）：` +
        (session.errorTail.length > 0 ? session.errorTail.join(' | ') : '无 stderr 输出'),
    );
  });

  sessions.set(id, session);
  sessionKeys.set(opts.sessionKey, id);
  ensureCleanupTimer();

  console.log(
    `[transcode] 启动会话 ${id}（${mode}，起点 ${startTime}s）：${formatArgsForLog(args)}`,
  );
  return session;
}

/** 取会话（不存在/已回收返回 undefined）。 */
export function getSession(id: string): TranscodeSession | undefined {
  return sessions.get(id);
}

/** 续期：路由层每次成功访问播放列表/分片时调用。 */
export function touchSession(id: string): void {
  const session = sessions.get(id);
  if (session) session.lastAccessAt = Date.now();
}

/** 停止并删除会话（kill ffmpeg + 递归删除目录），返回是否确实存在该会话。 */
export async function stopSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;

  sessions.delete(id);
  if (sessionKeys.get(session.sessionKey) === id) {
    sessionKeys.delete(session.sessionKey);
  }

  const child = session.process;
  killProcess(session);
  await waitForExit(child, 2000);
  await removeDirWithRetry(session.dir);
  return true;
}

/** 清理全部会话（进程退出时调用）。 */
export async function cleanupAll(): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return;
  for (const id of ids) {
    await stopSession(id);
  }
  sessions.clear();
  sessionKeys.clear();
  console.log(`[transcode] 已清理全部转码会话（${ids.length} 个）`);
}

/**
 * 模块 dispose 钩子：清掉定时器并回收全部会话。
 * 由后端 gracefulShutdown（index.ts）调用，保证退出时不留 ffmpeg 僵尸进程与残留目录。
 */
export async function disposeTranscodeSessions(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  await cleanupAll();
}
