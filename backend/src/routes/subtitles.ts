/**
 * 字幕自动搜索 & 目录浏览路由
 *
 * 挂载路径：/api/subtitles
 *
 * 功能：
 *   GET /search?movieId=           搜索影片同目录下的同名字幕文件
 *   GET /browse?movieId=&path=     浏览影片所在目录（或指定子目录），返回文件列表
 *   GET /load?movieId=&path=       读取指定字幕文件内容
 *
 * 设计要点：
 * - 通过 movieId 从 Movie 表获取 source/path/serverUrl/username/password
 * - 支持 webdav / openlist（AList HTTP API）/ ftp / server-files 四种源
 * - browse 返回统一格式的文件列表（name/path/type/isSubtitle）
 * - load 返回字幕文件内容（非 URL），前端解析后转为 data URL 供 socket 同步
 *
 * v2 重构：OpenList 不再复用 WebDAV 协议，改用 AList HTTP API
 * （listOpenListDirectory / fetchOpenListFileInfo），密码使用 SHA-256 哈希。
 */
import { Router, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { AppDataSource } from '../data-source';
import { Movie } from '../entities/Movie';
import { UserMount } from '../entities/UserMount';
import { ServerFolder } from '../entities/ServerFolder';
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth';
import { CONFIG_DIR } from '../services/paths';

// WebDAV 服务（仅用于 webdav 源）
import {
  listWebDAVDirectory,
  createWebDAVReadStream,
  buildWebDAVDirectUrl,
  type WebDAVConnectionParams,
} from '../services/webdav';

// OpenList 服务（AList HTTP API，用于 openlist 源）
import {
  listOpenListDirectory,
  fetchOpenListFileInfo,
  type OpenListBrowseEntry,
} from '../services/openlist';

// FTP 服务
import {
  listFTPDirectory,
  createFTPReadStream,
  type FTPConnectionParams,
} from '../services/ftp';

// 服务器文件服务
import {
  UPLOADS_ROOT_KEY,
  getUploadsRoot,
  resolveSafePath,
  type RootRegistry,
} from '../services/server-files/pathResolver';

// Emby 字幕（直接调用 Emby 自带的字幕接口）
import { EmbyClient, createEmbyClientFromMount } from '../services/emby-client';
// 第三方 Emby 兼容服务的原生 API 字幕兜底（其兼容层常常没有字幕端点）
import { createNativeApiFromMount } from '../services/emby-native';
// 服务端 MKV 解容器取字幕（不依赖 ffmpeg / 浏览器 / Range）
import {
  probeMkvSubtitleTracks,
  extractMkvSubtitleTrack,
  type MkvSubtitleTrackInfo,
} from '../services/mkv-subtitles';

const router = Router();

// 所有字幕搜索接口需要认证
router.use(authenticateToken);

/** ServerFolder 仓库。 */
const folderRepo = () => AppDataSource.getRepository(ServerFolder);

/**
 * 加载所有根目录到注册表。
 * uploads 根始终存在；自定义根按数据库记录注册。
 */
async function loadRootRegistry(): Promise<RootRegistry> {
  const map: RootRegistry = new Map();
  map.set(UPLOADS_ROOT_KEY, getUploadsRoot());
  const folders = await folderRepo().find({ order: { id: 'ASC' } });
  for (const f of folders) {
    const key = `custom:${f.id}`;
    map.set(key, {
      key,
      name: f.name,
      absPath: path.resolve(f.absPath),
      readonly: !!f.readonly,
    });
  }
  return map;
}

/**
 * 从 UserMount 表补全 WebDAV/OpenList/FTP 凭证。
 *
 * 已有电影可能在创建时未存储 username/password（旧版本前端不传凭证），
 * 此函数按 serverUrl 跨所有用户查找匹配的挂载记录，回填缺失的凭证。
 */
async function fillCredentialsFromMount(
  movie: Movie,
): Promise<{ username?: string; password?: string }> {
  if (!movie.serverUrl) return {};
  // 电影本身已有完整凭证，无需回退
  if (movie.username && movie.password) {
    return { username: movie.username, password: movie.password };
  }
  const source = (movie.source || '').toLowerCase();
  const mountType = source === 'openlist' ? 'openlist' : source === 'ftp' ? 'ftp' : 'webdav';
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: mountType as 'webdav' | 'openlist' | 'ftp',
  });
  if (mount) {
    return {
      username: movie.username || mount.username || undefined,
      password: movie.password || mount.password || undefined,
    };
  }
  return {
    username: movie.username || undefined,
    password: movie.password || undefined,
  };
}

/** 支持的字幕扩展名 */
const SUBTITLE_EXTS = ['.vtt', '.srt', '.ass', '.ssa', '.smi', '.sami', '.sub'];

/** 从文件名提取扩展名（小写） */
function getExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/** 从路径中提取文件名 */
function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || '';
}

/** 从路径中提取所在目录路径 */
function dirname(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '/';
}

/** 从文件名中去除扩展名 */
function stripExt(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** 将流读取为字符串 */
function streamToString(
  stream: import('node:stream').Readable,
  maxBytes = 2 * 1024 * 1024, // 2MB 上限
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    stream.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        stream.destroy();
        reject(new Error('字幕文件过大（超过 2MB）'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    stream.on('error', reject);
  });
}

/**
 * 通过 AList HTTP API 读取 OpenList 文件内容。
 *
 * 流程：
 * 1. 调用 fetchOpenListFileInfo 获取带签名的 raw_url
 * 2. HTTP GET raw_url 读取文件字节流
 * 3. 转为 UTF-8 字符串返回
 *
 * 与 createWebDAVReadStream 不同，此函数走 AList 的 /api/fs/get 端点，
 * 使用 SHA-256 哈希密码（通过 /api/auth/login/hash 登录），不再依赖 WebDAV 协议。
 *
 * @param serverUrl  OpenList 服务器地址（可含 /dav 后缀）
 * @param username   用户名（匿名场景为 undefined）
 * @param password   哈希密码（由路由层 normalizePasswordForStorage 生成）
 * @param filePath   文件在 OpenList 中的绝对路径
 * @returns 文件文本内容
 */
async function readOpenListFileContent(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  filePath: string,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  const info = await fetchOpenListFileInfo(serverUrl, username, password, filePath);
  if (!info.rawUrl) {
    throw new Error('OpenList 未返回文件直链');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(info.rawUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenList 读取字幕失败: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error('字幕文件过大（超过 2MB）');
    }
    return buf.toString('utf-8');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将 OpenList 目录条目转换为字幕路由统一的 BrowseEntry 格式。
 *
 * OpenList 的 entry.isDir 对应 WebDAV 的 type='directory'，
 * 其他字段（name/size）语义一致。
 */
function openListEntryToBrowseEntry(
  entry: OpenListBrowseEntry,
  dirPath: string,
): { name: string; path: string; type: 'file' | 'directory'; size?: number } {
  const itemPath = dirPath.endsWith('/')
    ? `${dirPath}${entry.name}`
    : `${dirPath}/${entry.name}`;
  return {
    name: entry.name,
    path: itemPath,
    type: entry.isDir ? 'directory' : 'file',
    size: entry.size,
  };
}

interface SubtitleSearchResult {
  filename: string;
  format: string;
  content: string;
}

/**
 * GET /search?movieId=
 *
 * 根据影片 ID 搜索同目录下的字幕文件，返回匹配的字幕内容。
 *
 * 响应：
 *   200 { success: true, subtitles: SubtitleSearchResult[] }
 *   400/404/500 { success: false, message: string }
 */
router.get('/search', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      // 非文件源类型（如 bilibili），不支持字幕搜索
      res.json({ success: true, subtitles: [] });
      return;
    }

    if (!movie.path) {
      res.json({ success: true, subtitles: [] });
      return;
    }

    const videoFilename = basename(movie.path);
    const videoBasename = stripExt(videoFilename);
    const dirPath = dirname(movie.path);

    if (!videoBasename) {
      res.json({ success: true, subtitles: [] });
      return;
    }

    // 列出目录内容并读取匹配的字幕文件
    const subtitles: SubtitleSearchResult[] = [];

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: dirAbs } = resolveSafePath(dirPath, roots);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const files = fs.readdirSync(dirAbs);
      for (const file of files) {
        const ext = getExt(file);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!file.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${file}`
          : `${dirPath}/${file}`;
        const { abs: fileAbs } = resolveSafePath(filePath, roots);
        try {
          const content = fs.readFileSync(fileAbs, 'utf-8');
          subtitles.push({ filename: file, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] 读取字幕文件失败: ${file}`, err);
        }
      }
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: dirPath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const entries = await listFTPDirectory(params, dirPath);
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const readParams: FTPConnectionParams = {
            serverUrl: movie.serverUrl,
            path: filePath,
            port: undefined,
            username: creds.username,
            password: creds.password,
          };
          const stream = createFTPReadStream(readParams, 0);
          const content = await streamToString(stream);
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] FTP 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const result = await listOpenListDirectory(
        movie.serverUrl,
        creds.username,
        creds.password,
        dirPath,
      );
      for (const entry of result.entries) {
        if (entry.isDir) continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const content = await readOpenListFileContent(
            movie.serverUrl,
            creds.username,
            creds.password,
            filePath,
          );
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] OpenList 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.json({ success: true, subtitles: [] });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: dirPath,
        username: creds.username,
        password: creds.password,
      };
      const entries = await listWebDAVDirectory(params, dirPath);
      for (const entry of entries) {
        if (entry.type !== 'file') continue;
        const ext = getExt(entry.name);
        if (!SUBTITLE_EXTS.includes(ext)) continue;
        if (!entry.name.toLowerCase().startsWith(videoBasename.toLowerCase())) continue;

        const filePath = dirPath.endsWith('/')
          ? `${dirPath}${entry.name}`
          : `${dirPath}/${entry.name}`;
        try {
          const readParams: WebDAVConnectionParams = {
            serverUrl: movie.serverUrl,
            path: filePath,
            username: creds.username,
            password: creds.password,
          };
          const stream = createWebDAVReadStream(readParams);
          const content = await streamToString(stream);
          subtitles.push({ filename: entry.name, format: ext.slice(1), content });
        } catch (err) {
          console.warn(`[subtitles] WebDAV 读取字幕文件失败: ${entry.name}`, err);
        }
      }
    }

    res.json({ success: true, subtitles });
  } catch (err) {
    console.error('[subtitles] search error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '搜索字幕失败',
      });
    }
  }
});

interface BrowseEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  isSubtitle: boolean;
  size?: number;
}

/**
 * GET /browse?movieId=&path=
 *
 * 浏览影片所在目录（或指定子目录），返回文件列表。
 * path 省略时默认浏览影片所在目录。
 *
 * 响应：
 *   200 { success: true, entries: BrowseEntry[], currentPath: string, parentPath: string | null }
 *   400/404/500 { success: false, message: string }
 */
router.get('/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      res.status(400).json({ success: false, message: '该影片源类型不支持目录浏览' });
      return;
    }

    if (!movie.path) {
      res.status(400).json({ success: false, message: '影片没有路径信息' });
      return;
    }

    // 目标目录：优先使用 query path，否则使用影片所在目录
    const videoDir = dirname(movie.path);
    const targetPath = typeof req.query.path === 'string' && req.query.path.trim()
      ? req.query.path.trim()
      : videoDir;

    const entries: BrowseEntry[] = [];

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: dirAbs } = resolveSafePath(targetPath, roots);
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        res.json({ success: true, entries: [], currentPath: targetPath, parentPath: null });
        return;
      }
      const items = fs.readdirSync(dirAbs, { withFileTypes: true });
      for (const item of items) {
        if (item.name.startsWith('.')) continue;
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${item.name}`
          : `${targetPath}/${item.name}`;
        const ext = getExt(item.name);
        const isFile = item.isFile();
        entries.push({
          name: item.name,
          path: itemPath,
          type: item.isDirectory() ? 'directory' : 'file',
          isSubtitle: isFile && SUBTITLE_EXTS.includes(ext),
          size: isFile ? fs.statSync(path.join(dirAbs, item.name)).size : undefined,
        });
      }
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'FTP 服务器地址缺失' });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: targetPath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const list = await listFTPDirectory(params, targetPath);
      for (const entry of list) {
        const ext = getExt(entry.name);
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${entry.name}`
          : `${targetPath}/${entry.name}`;
        entries.push({
          name: entry.name,
          path: itemPath,
          type: entry.type,
          isSubtitle: entry.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: entry.size,
        });
      }
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'OpenList 服务器地址缺失' });
        return;
      }
      const result = await listOpenListDirectory(
        movie.serverUrl,
        creds.username,
        creds.password,
        targetPath,
      );
      for (const entry of result.entries) {
        const ext = getExt(entry.name);
        const converted = openListEntryToBrowseEntry(entry, targetPath);
        entries.push({
          name: converted.name,
          path: converted.path,
          type: converted.type,
          isSubtitle: converted.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: converted.size,
        });
      }
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'WebDAV 服务器地址缺失' });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: targetPath,
        username: creds.username,
        password: creds.password,
      };
      const list = await listWebDAVDirectory(params, targetPath);
      for (const entry of list) {
        const ext = getExt(entry.name);
        const itemPath = targetPath.endsWith('/')
          ? `${targetPath}${entry.name}`
          : `${targetPath}/${entry.name}`;
        entries.push({
          name: entry.name,
          path: itemPath,
          type: entry.type,
          isSubtitle: entry.type === 'file' && SUBTITLE_EXTS.includes(ext),
          size: entry.size,
        });
      }
    }

    // 排序：目录在前，文件在后，各自按名称排序
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });

    // 计算父目录路径
    const normalized = targetPath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    const parentPath = lastSlash > 0 ? normalized.slice(0, lastSlash) : null;

    res.json({ success: true, entries, currentPath: targetPath, parentPath });
  } catch (err) {
    console.error('[subtitles] browse error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '浏览目录失败',
      });
    }
  }
});

/**
 * GET /load?movieId=&path=
 *
 * 读取指定路径的字幕文件内容。
 *
 * 响应：
 *   200 { success: true, filename: string, format: string, content: string }
 *   400/404/500 { success: false, message: string }
 */
router.get('/load', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    const filePath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    if (!filePath) {
      res.status(400).json({ success: false, message: '缺少 path 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
    if (!movie) {
      res.status(404).json({ success: false, message: '影片不存在' });
      return;
    }

    const source = (movie.source || '').toLowerCase();
    if (!['webdav', 'openlist', 'ftp', 'server-files'].includes(source)) {
      res.status(400).json({ success: false, message: '该影片源类型不支持字幕加载' });
      return;
    }

    const filename = basename(filePath);
    const ext = getExt(filename);
    if (!SUBTITLE_EXTS.includes(ext)) {
      res.status(400).json({ success: false, message: '该文件不是支持的字幕格式' });
      return;
    }

    let content: string;

    // 回退查询 UserMount 补全凭证（兼容旧电影未存储凭证的情况）
    const creds = source !== 'server-files' ? await fillCredentialsFromMount(movie) : {};

    if (source === 'server-files') {
      // ── 服务器文件 ──
      const roots = await loadRootRegistry();
      const { abs: fileAbs } = resolveSafePath(filePath, roots);
      if (!fs.existsSync(fileAbs) || fs.statSync(fileAbs).isDirectory()) {
        res.status(404).json({ success: false, message: '字幕文件不存在' });
        return;
      }
      content = fs.readFileSync(fileAbs, 'utf-8');
    } else if (source === 'ftp') {
      // ── FTP ──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'FTP 服务器地址缺失' });
        return;
      }
      const params: FTPConnectionParams = {
        serverUrl: movie.serverUrl,
        path: filePath,
        port: undefined,
        username: creds.username,
        password: creds.password,
      };
      const stream = createFTPReadStream(params, 0);
      content = await streamToString(stream);
    } else if (source === 'openlist') {
      // ── OpenList（AList HTTP API，密码为 SHA-256 哈希）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'OpenList 服务器地址缺失' });
        return;
      }
      content = await readOpenListFileContent(
        movie.serverUrl,
        creds.username,
        creds.password,
        filePath,
      );
    } else {
      // ── WebDAV（明文密码 + WebDAV 协议）──
      if (!movie.serverUrl) {
        res.status(400).json({ success: false, message: 'WebDAV 服务器地址缺失' });
        return;
      }
      const params: WebDAVConnectionParams = {
        serverUrl: movie.serverUrl,
        path: filePath,
        username: creds.username,
        password: creds.password,
      };
      const stream = createWebDAVReadStream(params);
      content = await streamToString(stream);
    }

    res.json({ success: true, filename, format: ext.slice(1), content });
  } catch (err) {
    console.error('[subtitles] load error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '加载字幕失败',
      });
    }
  }
});

// ==================== 内嵌字幕 ====================

/**
 * 解析 Emby / Jellyfin 播放所需的客户端与用户（直接调用其自带字幕接口）。
 *
 * Emby / Jellyfin 字幕不依赖"服务器中转"：后端始终持有 serverUrl + API Key/凭证，
 * 无论视频走直链还是服务器中转，都能调 PlaybackInfo / Subtitles Stream。
 */
async function resolveEmbyContext(movie: Movie): Promise<{
  client: EmbyClient;
  itemId: string;
  userId: string;
}> {
  const source = (movie.source || '').toLowerCase();
  if (source !== 'emby' && source !== 'jellyfin') {
    throw new Error('该源暂不支持内嵌字幕');
  }
  if (!movie.serverUrl || !movie.path) {
    throw new Error('该影片未挂载服务器信息');
  }
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: source === 'jellyfin' ? 'jellyfin' : 'emby',
  });
  const client = await createEmbyClientFromMount({
    serverUrl: movie.serverUrl,
    apiKey: mount?.apiKey,
    username: movie.username || mount?.username || undefined,
    password: movie.password || mount?.password || undefined,
  });
  let userId = mount?.embyUserId ?? '';
  if (!userId) {
    const me = await client.me();
    userId = me.Id;
  }
  return { client, itemId: movie.path, userId };
}

/**
 * 取影片对应的挂载（原生 API 兜底需要挂载里的 serverUrl 与凭证）。
 * 与 resolveEmbyContext 的查找方式一致：serverUrl + type。
 */
async function findMountForMovie(
  movie: Movie,
): Promise<UserMount | null> {
  if (!movie.serverUrl) return null;
  const source = (movie.source || '').toLowerCase();
  if (source !== 'emby' && source !== 'jellyfin') return null;
  return AppDataSource.getRepository(UserMount).findOneBy({
    serverUrl: movie.serverUrl,
    type: source === 'jellyfin' ? 'jellyfin' : 'emby',
  });
}

/**
 * 第三方兼容服务（uhdnow 系）的原生 API 字幕列表。
 * Emby 兼容层没有字幕端点时，字幕以独立文件形式存在于原生 API 里。
 * 返回 null 表示该影片不适用/不可用（调用方回退到 Emby 兼容层）。
 */
async function listNativeSubtitleTracks(
  movie: Movie,
): Promise<Array<{
  index: number;
  codecName: string;
  language: string | null;
  title: string | null;
  label: string;
  isText: boolean;
  native: true;
  asset: { url?: string; play_path?: string; download_path?: string };
}> | null> {
  try {
    const mount = await findMountForMovie(movie);
    if (!mount || !movie.path) return null;
    const client = createNativeApiFromMount(mount);
    if (!client) return null;
    const assets = await client.subtitleAssets(movie.path);
    if (assets.subtitles.length === 0) return null;
    return assets.subtitles.map((sub, i) => {
      const format = (sub.format || '').trim().toLowerCase();
      const label =
        sub.name?.trim() ||
        [sub.language?.trim(), format].filter(Boolean).join(' · ') ||
        `字幕 ${i + 1}`;
      return {
        index: i,
        codecName: format || 'unknown',
        language: sub.language ?? null,
        title: sub.name ?? null,
        label,
        // 原生 API 下发的都是独立文本字幕文件
        isText: true,
        native: true as const,
        asset: {
          url: sub.url,
          play_path: sub.play_path,
          download_path: sub.download_path,
        },
      };
    });
  } catch (err) {
    console.warn(
      '[subtitles] 原生 API 字幕列表不可用:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * 服务端 MKV 解容器：列出影片原始容器里的文本字幕轨。
 * 用于媒体服务器既没有字幕端点、也没有外挂字幕文件的服务（如 UHD Media Server）。
 * 返回 null 表示不可用（非 MKV / 无文本字幕轨 / 读不到流）。
 */
/**
 * 轨道探测结果缓存（进程内）。
 * 探测本身要向上游发 2~4 个请求（打开流 + 读文件头），每次切影片/重播都探一遍
 * 会白白多等 1~2s；命中缓存则字幕请求几乎立刻发出。
 * 失败结果只缓存 60s（可能是上游限流/网络抖动，不宜长期钉死）。
 */
/** /embedded-tracks 响应缓存（按影片 + updatedAt 版本，见路由内说明） */
const embeddedTracksCache = new Map<
  number,
  { at: number; updatedAt: number; payload: Record<string, unknown> }
>();
const EMBEDDED_TRACKS_TTL_MS = 5 * 60 * 1000;

/** 容器探测结果：文本字幕轨 + Range 支持 + 文件大小（提取策略用） */
interface ServerMkvTracks {
  tracks: MkvSubtitleTrackInfo[];
  rangeSupported: boolean;
  fileSize: number;
}

const mkvProbeCache = new Map<
  number,
  { at: number; value: ServerMkvTracks | null }
>();
const MKV_PROBE_TTL_MS = 10 * 60 * 1000;
const MKV_PROBE_FAILURE_TTL_MS = 60 * 1000;

async function listServerMkvTracks(
  movie: Movie,
): Promise<ServerMkvTracks | null> {
  const cached = mkvProbeCache.get(movie.id);
  if (cached) {
    const ttl = cached.value ? MKV_PROBE_TTL_MS : MKV_PROBE_FAILURE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
  }
  try {
    const ctx = await resolveEmbyContext(movie);
    const src = ctx.client.getStaticStreamSource(ctx.itemId);
    const probe = await probeMkvSubtitleTracks({
      url: src.url,
      headers: src.headers,
      timeoutMs: 60_000,
    });
    const tracks = probe.tracks.filter((t) => t.isText);
    const value =
      tracks.length === 0
        ? null
        : { tracks, rangeSupported: probe.rangeSupported, fileSize: probe.fileSize };
    mkvProbeCache.set(movie.id, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(
      '[subtitles] 服务端 MKV 字幕探测失败:',
      err instanceof Error ? err.message : err,
    );
    mkvProbeCache.set(movie.id, { at: Date.now(), value: null });
    return null;
  }
}

/** 提取结果缓存：同一影片同一轨重复请求直接复用（解容器需读整文件，代价高） */
interface MkvCachedSubtitle {
  content: string;
  format: string;
  label: string;
  language: string | null;
  at: number;
  /**
   * 缓存格式版本。
   * v2 起：只有「读到文件末尾」的完整提取才会落盘。
   * 早期版本曾把「跳读中途中断」的部分结果当完整结果缓存，导致字幕只到前几分钟，
   * 因此不带 v2 的旧缓存一律视为无效并重新提取。
   */
  v?: number;
}
const MKV_CACHE_VERSION = 2;
const mkvExtractCache = new Map<string, MkvCachedSubtitle>();
const MKV_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * 磁盘缓存：服务端解容器要把整个文件顺序读一遍（单集约 1GB），
 * 因此结果必须跨重启、跨观看者复用——「管理员/房主提取一次，
 * 之后所有人直接命中缓存」，否则每个观看者都要重跑一遍。
 */
const MKV_CACHE_DIR = path.join(CONFIG_DIR, 'subtitle-cache');

/** 缓存文件名带 updatedAt：影片元数据/文件刷新后自动失效 */
function mkvCachePath(movie: Movie, track: number): string {
  const version = movie.updatedAt ? new Date(movie.updatedAt).getTime() : 0;
  return path.join(MKV_CACHE_DIR, `mkv-${movie.id}-${track}-${version}.json`);
}

function readMkvCacheFromDisk(movie: Movie, track: number): MkvCachedSubtitle | null {
  try {
    const raw = fs.readFileSync(mkvCachePath(movie, track), 'utf8');
    const parsed = JSON.parse(raw) as MkvCachedSubtitle;
    if (
      parsed &&
      typeof parsed.content === 'string' &&
      parsed.content.length > 0 &&
      parsed.v === MKV_CACHE_VERSION
    ) {
      return parsed;
    }
  } catch {
    /* 尚未缓存 / 缓存损坏 → 重新提取 */
  }
  return null;
}

function writeMkvCacheToDisk(movie: Movie, track: number, value: MkvCachedSubtitle): void {
  try {
    fs.mkdirSync(MKV_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      mkvCachePath(movie, track),
      JSON.stringify({ ...value, v: MKV_CACHE_VERSION }),
      'utf8',
    );
  } catch (err) {
    console.warn(
      '[subtitles] 写入字幕缓存失败:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 后台提取（fire-and-forget）：解容器要顺序读完整集（约 1~2 分钟），
 * 同步等待会让反向代理在无数据期间超时（实测 504），也让观看者干等；
 * 因此改为「请求立即返回 pending → 前端轮询 → 提取结果落盘」。
 * 同一影片同一轨只会跑一次，多观看者共享。
 */
const mkvInflight = new Set<string>();
/**
 * 提取中的「部分结果」：整集要顺序读 1~2 分钟，边读边把已解析到的字幕
 * 返回给前端，字幕秒级可用（后面继续补齐），而不是让用户干等完整提取。
 */
const mkvPartial = new Map<string, MkvCachedSubtitle & { partial: true }>();
/** 最近一次提取失败原因：轮询方立即拿到真实原因，而不是一直等到超时 */
/**
 * 字幕提取的读取限速（字节/秒，0 = 不限速）。
 * 默认 0：大文件会自适应切到 Range 跳读（只下载字幕块，带宽占用极小），
 * 无需再靠限速保护起播；如需给顺序流兜底限速，设 MKV_EXTRACT_MAX_MBPS。
 */
const MKV_EXTRACT_MAX_BYTES_PER_SEC = (() => {
  const raw = process.env.MKV_EXTRACT_MAX_MBPS;
  if (raw === undefined) return 0;
  const mbps = Number(raw);
  if (!Number.isFinite(mbps) || mbps < 0) return 0;
  return Math.round(mbps * 1024 * 1024);
})();

const mkvFailures = new Map<string, { message: string; at: number }>();
const MKV_FAILURE_TTL_MS = 2 * 60 * 1000;

function startMkvExtractionInBackground(
  movie: Movie,
  track: number,
  cacheKey: string,
  /** 文件大小（探测阶段拿到）：提取阶段据此选择跳读 / 顺序流 */
  fileSizeHint?: number,
): boolean {
  if (mkvInflight.has(cacheKey)) return false;
  // 同时最多跑 2 个解容器任务：每个都要顺序读完整集，开太多会挤占带宽
  // 并触发上游限流；超出的请求排队，前端下一次轮询会重新触发
  if (mkvInflight.size >= 2) return false;
  mkvInflight.add(cacheKey);
  mkvFailures.delete(cacheKey);
  void (async () => {
    try {
      const ctx = await resolveEmbyContext(movie);
      const src = ctx.client.getStaticStreamSource(ctx.itemId);
      const labelOf = (name?: string, language?: string, format?: string): string =>
        name?.trim() ||
        [language?.trim(), (format || '').toUpperCase()].filter(Boolean).join(' · ') ||
        `轨道 ${track}`;
      const result = await extractMkvSubtitleTrack(
        {
          url: src.url,
          headers: src.headers,
          timeoutMs: 900_000,
          // 文件大小提示：大文件走 Range 跳读（只下载字幕附近的块，
          // 940MB 单集的完整字幕从分钟级降到十几秒），小文件仍走顺序流。
          fileSizeHint,
          // 顺序流模式的读取限速：字幕提取与播放同时进行，全速拉整集会挤占
          // 「服务器 → 媒体源」带宽导致起播卡顿；限速后开头 cue 仍秒级到达。
          // MKV_EXTRACT_MAX_MBPS=0 可关闭限速（内网/带宽充裕时更快）。
          // 跳读模式下不适用（本来就不下载整集）。
          maxBytesPerSec: MKV_EXTRACT_MAX_BYTES_PER_SEC,
        },
        track,
        (partial) => {
          mkvPartial.set(cacheKey, {
            content: partial,
            format: 'ass',
            label: labelOf(undefined, undefined, 'ass'),
            language: null,
            at: Date.now(),
            partial: true,
          });
        },
      );
      const label =
        result.track.name?.trim() ||
        [result.track.language?.trim(), result.format.toUpperCase()]
          .filter(Boolean)
          .join(' · ') ||
        `轨道 ${track}`;
      // 只缓存「读到文件末尾」的完整结果：中途中断的内容若被当成完整结果落盘，
      // 之后每次播放都只显示前几分钟的字幕（且不会重新提取），极难排查。
      if (result.complete === false) {
        const message =
          '字幕提取中途中断（上游限流或网络异常），仅取到部分内容；稍后重试或改用其他字幕轨';
        console.warn(
          `[subtitles] 提取不完整，不写入缓存 movie=${movie.id} track=${track} ${result.content.length} 字节`,
        );
        mkvPartial.delete(cacheKey);
        mkvFailures.set(cacheKey, { message, at: Date.now() });
        return;
      }
      const value: MkvCachedSubtitle = {
        content: result.content,
        format: result.format,
        label,
        language: result.track.language ?? null,
        at: Date.now(),
        v: MKV_CACHE_VERSION,
      };
      mkvExtractCache.set(cacheKey, value);
      mkvPartial.delete(cacheKey);
      writeMkvCacheToDisk(movie, track, value);
      console.info(
        `[subtitles] 服务端字幕提取完成 movie=${movie.id} track=${track} ${result.format} ${result.content.length} 字节`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : '字幕提取失败';
      console.warn('[subtitles] 服务端字幕提取失败:', message);
      mkvPartial.delete(cacheKey);
      mkvFailures.set(cacheKey, { message, at: Date.now() });
    } finally {
      mkvInflight.delete(cacheKey);
    }
  })();
  return true;
}

/** Emby 字幕 codec → 提取后缀与前端解析格式。
 *  注意：Emby 的 Subtitles Stream 端点按扩展名路由转封装输出，
 *  裸 `/Stream`（无扩展名）会 404——srt 也必须显式带 `.srt` 后缀。 */
function mapEmbySubtitleFormat(
  codec: string,
): { ext: string; format: 'srt' | 'ass' | 'vtt' } {
  switch (codec) {
    case 'ass':
    case 'ssa':
      return { ext: 'ass', format: 'ass' };
    case 'webvtt':
      return { ext: 'vtt', format: 'vtt' };
    case 'srt':
    case 'subrip':
    default:
      return { ext: 'srt', format: 'srt' };
  }
}

/**
 * 列出视频的内嵌字幕轨道：
 * - emby：直接读 Emby PlaybackInfo 的 MediaStreams（Type===Subtitle）
 * - 其余来源：内嵌字幕提取已前端化（浏览器端 MKV demux），后端不再支持
 */
router.get(
  '/embedded-tracks',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const movieId = Number(req.query.movieId);
      if (!Number.isFinite(movieId)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const source = (movie.source || '').toLowerCase();

      if (source === 'emby' || source === 'jellyfin') {
        // 探测结果按影片缓存：本函数最多要向上游发若干个请求（原生 API + 容器
        // 探测），每次切影片/重播都重跑会白等 0.5~2s。缓存以影片 updatedAt 为
        // 版本号，元数据变化自动失效。
        const movieVersion = movie.updatedAt ? new Date(movie.updatedAt).getTime() : 0;
        const cachedTracks = embeddedTracksCache.get(movie.id);
        if (
          cachedTracks &&
          cachedTracks.updatedAt === movieVersion &&
          Date.now() - cachedTracks.at < EMBEDDED_TRACKS_TTL_MS
        ) {
          res.json(cachedTracks.payload);
          return;
        }
        const respond = (payload: Record<string, unknown>): void => {
          embeddedTracksCache.set(movie.id, {
            at: Date.now(),
            updatedAt: movieVersion,
            payload,
          });
          res.json(payload);
        };

        // 1) 第三方兼容服务的原生 API：外挂字幕以独立文件下发
        const nativeTracks = await listNativeSubtitleTracks(movie);
        if (nativeTracks && nativeTracks.length > 0) {
          respond({ success: true, tracks: nativeTracks, native: true });
          return;
        }

        // 2) 服务端解容器：MKV 内嵌字幕（媒体服务器没有字幕端点时的可靠路径）
        const mkvProbe = await listServerMkvTracks(movie);
        if (mkvProbe) {
          respond({
            success: true,
            mkv: true,
            rangeSupported: mkvProbe.rangeSupported,
            tracks: mkvProbe.tracks.map((t) => ({
              index: t.trackNumber,
              codecName: t.codecId,
              language: t.language ?? null,
              title: t.name ?? null,
              label:
                t.name?.trim() ||
                [t.language?.trim(), t.format.toUpperCase()].filter(Boolean).join(' · ') ||
                `轨道 ${t.trackNumber}`,
              isText: true,
              mkv: true,
            })),
          });
          return;
        }

        // 3) 回退 Emby 兼容层 PlaybackInfo
        const ctx = await resolveEmbyContext(movie);
        // subtitleProfile: 让 Emby 下发每条字幕流的 DeliveryUrl（取字幕文件的地址）
        const playback = await ctx.client.playbackInfo(ctx.itemId, ctx.userId, {
          subtitleProfile: true,
        });
        const mediaSource = playback.MediaSources[0];
        const subtitleStreams = (mediaSource?.MediaStreams ?? []).filter(
          (s) => s.Type === 'Subtitle',
        );
        const tracks = subtitleStreams.map((t) => ({
          index: t.Index,
          codecName: t.Codec || 'unknown',
          language: t.Language || null,
          title: t.DisplayTitle || null,
          label: t.DisplayTitle || t.Language || `轨道 ${t.Index}`,
          // 自动挑选字幕轨所需信息：文本轨优先、默认轨次之、强制轨最后。
          // IsTextSubtitleStream 部分版本不返回（undefined）→ 前端按 Codec 兜底判断。
          isDefault: t.IsDefault === true,
          isForced: t.IsForced === true,
          isText: t.IsTextSubtitleStream,
          isExternal: t.IsExternal === true,
        }));
        res.json({ success: true, tracks });
        return;
      }

      res.status(400).json({
        success: false,
        message: '该来源的内嵌字幕提取已前端化，后端不再提供探测',
      });
    } catch (err) {
      console.error('[subtitles] embedded-tracks error:', err);
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '获取内嵌字幕轨道失败',
      });
    }
  },
);

/**
 * GET /emby-web-probe?movieId=
 *
 * 诊断用（仅 root/admin）：把该 Emby 服务器自带 web 播放器的 JS 抓下来，
 * 搜索它究竟用哪个地址取字幕（DeliveryUrl / Subtitles/ / subtitles.m3u8 …），
 * 返回命中片段。这样不必让用户手动翻 DevTools。
 */
router.get(
  '/emby-web-probe',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const role = req.user?.role;
      if (role !== 'root' && role !== 'admin') {
        res.status(403).json({ success: false, message: '无权限：仅管理员可诊断' });
        return;
      }
      const movieId = Number(req.query.movieId);
      if (!Number.isFinite(movieId)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const ctx = await resolveEmbyContext(movie);

      // 1) 找到 web 客户端入口页
      const pageCandidates = [
        '/emby/web/index.html',
        '/web/index.html',
        '/emby/web/',
        '/web/',
        '/index.html',
        '/',
        '/static/index.html',
      ];
      let pageUrl = '';
      let html = '';
      const pageErrors: string[] = [];
      for (const p of pageCandidates) {
        try {
          html = await ctx.client.fetchRawText(p);
          pageUrl = ctx.client.baseUrl + p;
          break;
        } catch (err) {
          pageErrors.push(p + ': ' + (err instanceof Error ? err.message : String(err)));
        }
      }
      if (!html) {
        res.status(400).json({
          success: false,
          message: '无法获取 Emby web 客户端入口页: ' + pageErrors.join(' | '),
        });
        return;
      }

      // 2) 取出所有脚本地址：<script src>、modulepreload 的 <link href>、
      //    以及内联 import()/from "..." 里的 .js 路径（SPA 常动态加载）
      const srcs: string[] = [
        ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
        ...[...html.matchAll(/<link[^>]+href=["']([^"']+\.m?js)["']/gi)].map((m) => m[1]),
        ...[...html.matchAll(/["']([^"']*\.m?js)["']/gi)].map((m) => m[1]),
      ];
      const urls: string[] = [];
      for (const s of srcs) {
        try {
          const abs = new URL(s, pageUrl).toString();
          if (!urls.includes(abs)) urls.push(abs);
        } catch {
          /* 忽略非法地址 */
        }
      }

      // 3) 下载脚本并搜索字幕取址相关代码
      const PATTERNS: Array<{ name: string; re: RegExp }> = [
        { name: 'DeliveryUrl', re: /DeliveryUrl/g },
        { name: 'getSubtitleUrl', re: /getSubtitleUrl/g },
        { name: 'Subtitles/', re: /Subtitles\//g },
        { name: 'subtitles.m3u8', re: /subtitles\.m3u8/g },
        { name: 'SubtitleProfiles', re: /SubtitleProfiles/g },
      ];
      const matches: Array<{ file: string; pattern: string; context: string }> = [];
      const fetched: Array<{ url: string; size: number; error?: string }> = [];
      for (const u of urls.slice(0, 15)) {
        if (matches.length >= 40) break;
        let body = '';
        try {
          body = await ctx.client.fetchRawText(u);
          fetched.push({ url: u, size: body.length });
        } catch (err) {
          fetched.push({
            url: u,
            size: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (const { name, re } of PATTERNS) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          let hits = 0;
          while ((m = re.exec(body)) && hits < 4 && matches.length < 40) {
            hits++;
            const start = Math.max(0, m.index - 160);
            matches.push({
              file: u.split('/').pop() || u,
              pattern: name,
              context: body.slice(start, m.index + 200).replace(/\s+/g, ' '),
            });
          }
        }
      }

      res.json({
        success: true,
        page: pageUrl,
        scriptCount: urls.length,
        // 找不到任何脚本时，回传入口页片段，便于人工判断结构
        htmlPreview: urls.length === 0 ? html.slice(0, 1200) : undefined,
        fetched,
        matches,
      });
    } catch (err) {
      console.error('[subtitles] emby-web-probe error:', err);
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '探测 Emby web 客户端失败',
      });
    }
  },
);

/**
 * GET /emby-diagnose?movieId=
 *
 * 字幕提取 404 的排查接口（仅 root/admin）：直接返回 Emby PlaybackInfo 的原始
 * 媒体源信息，重点看每条字幕流的 Index / Codec / IsExternal / DeliveryMethod /
 * DeliveryUrl —— 这些字段决定 emby-client 该用哪个地址取字幕。
 */
router.get(
  '/emby-diagnose',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const role = req.user?.role;
      if (role !== 'root' && role !== 'admin') {
        res.status(403).json({ success: false, message: '无权限：仅管理员可诊断' });
        return;
      }
      const movieId = Number(req.query.movieId);
      if (!Number.isFinite(movieId)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const ctx = await resolveEmbyContext(movie);
      // 服务端类型/版本（确认是 Emby 还是 Jellyfin、以及版本差异）
      const serverInfo = await ctx.client
        .systemInfoPublic()
        .catch(() => null as Record<string, unknown> | null);
      // subtitleProfile: 让 Emby 下发每条字幕流的 DeliveryUrl（取字幕文件的地址）
      const playback = await ctx.client.playbackInfo(ctx.itemId, ctx.userId, {
        subtitleProfile: true,
      });
      const sources = playback.MediaSources.map((s) => ({
        Id: s.Id,
        Container: s.Container,
        Path: s.Path,
        subtitleStreams: (s.MediaStreams ?? [])
          .filter((m) => m.Type === 'Subtitle')
          .map((m) => ({
            Index: m.Index,
            Codec: m.Codec,
            Language: m.Language,
            DisplayTitle: m.DisplayTitle,
            IsExternal: m.IsExternal,
            IsDefault: m.IsDefault,
            IsForced: m.IsForced,
            IsTextSubtitleStream: m.IsTextSubtitleStream,
            DeliveryMethod: m.DeliveryMethod,
            DeliveryUrl: m.DeliveryUrl,
            IsExternalUrl: m.IsExternalUrl,
          })),
      }));

      // 探测矩阵：把候选字幕地址全试一遍，直接看哪个地址 200
      const primary = playback.MediaSources[0];
      const subtitleStreams = (primary?.MediaStreams ?? []).filter(
        (m) => m.Type === 'Subtitle',
      );
      const wantIndex = Number.isFinite(Number(req.query.index))
        ? Number(req.query.index)
        : subtitleStreams[0]?.Index;
      const target = subtitleStreams.find((m) => m.Index === wantIndex) ?? subtitleStreams[0];
      let probes: unknown[] = [];
      if (target && primary) {
        const { ext } = mapEmbySubtitleFormat(target.Codec || '');
        probes = await ctx.client.probeSubtitleCandidates({
          itemId: ctx.itemId,
          mediaSourceId: primary.Id,
          index: target.Index,
          ordinal: subtitleStreams.findIndex((m) => m.Index === target.Index),
          format: ext,
          subtitleCount: subtitleStreams.length,
          playSessionId: playback.PlaySessionId,
          stream: {
            index: target.Index,
            codec: target.Codec,
            isExternal: target.IsExternal,
            deliveryMethod: target.DeliveryMethod,
            deliveryUrl: target.DeliveryUrl,
          },
        });
      }

      // 原生 API 诊断：第三方兼容服务的字幕文件就在这条链路上
      const nativeProbe = await (async () => {
        try {
          const mount = await findMountForMovie(movie);
          if (!mount || !movie.path) {
            return { ok: false, message: '该影片没有对应的挂载配置或缺少路径' };
          }
          const nativeClient = createNativeApiFromMount(mount);
          if (!nativeClient) return { ok: false, message: '无法创建原生 API 客户端' };
          const assets = await nativeClient.subtitleAssets(movie.path);
          const subtitles = assets.subtitles.map((s) => ({
            asset_id: s.asset_id,
            language: s.language,
            format: s.format,
            name: s.name,
            url: s.url,
            play_path: s.play_path,
            resolvedUrl: nativeClient.resolveAssetUrl(s, assets.domain),
          }));
          let preview: string | null = null;
          let fetchError: string | null = null;
          const first = subtitles[0];
          if (first?.resolvedUrl) {
            try {
              preview = (await nativeClient.fetchSubtitleText(first.resolvedUrl)).slice(0, 300);
            } catch (err) {
              fetchError = err instanceof Error ? err.message : String(err);
            }
          }
          return {
            ok: true,
            domain: assets.domain ?? null,
            videoCount: assets.videos.length,
            subtitleCount: subtitles.length,
            subtitles,
            preview,
            fetchError,
          };
        } catch (err) {
          return {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      })();

      // 服务端解容器探测：MKV 内嵌文本字幕轨 + 数据源是否支持 Range
      const mkvProbe = await listServerMkvTracks(movie);

      res.json({
        success: true,
        native: nativeProbe,
        mkv: mkvProbe
          ? { ok: true, rangeSupported: mkvProbe.rangeSupported, tracks: mkvProbe.tracks }
          : { ok: false },
        server: serverInfo
          ? {
              productName: serverInfo.ProductName ?? null,
              version: serverInfo.Version ?? null,
              serverName: serverInfo.ServerName ?? null,
              id: serverInfo.Id ?? null,
            }
          : null,
        source: (movie.source || '').toLowerCase(),
        itemId: ctx.itemId,
        userId: ctx.userId,
        playSessionId: playback.PlaySessionId ?? null,
        mediaSources: sources,
        probeTarget: target?.Index ?? null,
        probes,
      });
    } catch (err) {
      console.error('[subtitles] emby-diagnose error:', err);
      res.status(400).json({
        success: false,
        message: err instanceof Error ? err.message : '诊断失败',
      });
    }
  },
);

/**
 * 提取指定内嵌字幕轨道内容：
 * - emby：调 Emby Subtitles Stream 端点（Emby 自动转封装为 SRT/ASS/VTT）
 * - 其余来源：内嵌字幕提取已前端化（浏览器端 MKV demux），后端不再支持
 */
router.get(
  '/embedded-extract',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const movieId = Number(req.query.movieId);
      const streamIndex = Number(req.query.index);
      if (!Number.isFinite(movieId) || !Number.isFinite(streamIndex)) {
        res.status(400).json({ success: false, message: '缺少或无效的 movieId/index 参数' });
        return;
      }
      const movie = await AppDataSource.getRepository(Movie).findOneBy({ id: movieId });
      if (!movie) {
        res.status(400).json({ success: false, message: '影片不存在' });
        return;
      }
      const source = (movie.source || '').toLowerCase();

      if (source === 'emby' || source === 'jellyfin') {
        // 服务端解容器路径：index 为 MKV TrackNumber（embedded-tracks 返回 mkv=true）
        if (req.query.mkv === '1') {
          const cacheKey = `${movie.id}:${streamIndex}`;
          const cached = mkvExtractCache.get(cacheKey);
          if (cached && Date.now() - cached.at < MKV_CACHE_TTL_MS) {
            res.json({
              success: true,
              content: cached.content,
              format: cached.format,
              label: cached.label,
              language: cached.language,
              cached: true,
            });
            return;
          }
          // 磁盘缓存：跨重启 / 跨观看者复用（首次提取后所有人秒开）
          const fromDisk = readMkvCacheFromDisk(movie, streamIndex);
          if (fromDisk) {
            mkvExtractCache.set(cacheKey, fromDisk);
            res.json({
              success: true,
              content: fromDisk.content,
              format: fromDisk.format,
              label: fromDisk.label,
              language: fromDisk.language,
              cached: true,
            });
            return;
          }
          // 提取中：把「已读到的部分字幕」先返回（partial=true），字幕秒级可用，
          // 前端继续轮询直到拿到完整结果
          const partial = mkvPartial.get(cacheKey);
          if (partial && Date.now() - partial.at < 120_000) {
            res.json({
              success: true,
              partial: true,
              content: partial.content,
              format: partial.format,
              label: partial.label,
              language: partial.language,
            });
            return;
          }
          // 最近失败过（多为上游 429 限流）：直接返回原因，避免轮询空等
          const failure = mkvFailures.get(cacheKey);
          if (failure && Date.now() - failure.at < MKV_FAILURE_TTL_MS) {
            res.status(400).json({
              success: false,
              message: /HTTP 429/.test(failure.message)
                ? `${failure.message}（媒体服务器限流，稍等 1~2 分钟再试即可）`
                : failure.message,
            });
            return;
          }
          // 启动前先校验轨道确实存在：解容器要把整集顺序读一遍（约 1GB），
          // 不能为一个无效 index（前端轨道列表过期、误请求等）白跑一遍
          const known = await listServerMkvTracks(movie);
          if (!known) {
            res.status(400).json({
              success: false,
              message: '未能从容器中读到内嵌字幕轨（可能不是 MKV，或探测被上游限流）',
            });
            return;
          }
          if (!known.tracks.some((t) => t.trackNumber === streamIndex)) {
            res.status(400).json({
              success: false,
              message: `未找到字幕轨 ${streamIndex}（容器内文本字幕轨：${known.tracks
                .map((t) => t.trackNumber)
                .join('/')}）`,
            });
            return;
          }
          // 未命中缓存 → 启动后台提取，并**先等一小会儿首批 cue**：
          // 顺序读取下第一个 Cluster 的头几 MB 内就有字幕，通常 0.5~1.5s 可拿到，
          // 直接带回去能省掉一轮轮询（前端原本要等下一个 4s 轮询才有字幕）。
          // 超过等待窗口仍返回 202，长任务继续在后台跑（避免反向代理 504）。
          const started = startMkvExtractionInBackground(
            movie,
            streamIndex,
            cacheKey,
            known.fileSize,
          );
          const FIRST_PARTIAL_WAIT_MS = 1_500;
          const waitUntil = Date.now() + FIRST_PARTIAL_WAIT_MS;
          for (;;) {
            const first = mkvPartial.get(cacheKey);
            if (first) {
              res.json({
                success: true,
                partial: true,
                content: first.content,
                format: first.format,
                label: first.label,
                language: first.language,
              });
              return;
            }
            const failureEarly = mkvFailures.get(cacheKey);
            if (failureEarly) break;
            if (Date.now() >= waitUntil) break;
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          res.status(202).json({
            success: false,
            pending: true,
            message: started
              ? '首次提取内嵌字幕（需读完整集，约 1~2 分钟），完成后自动加载'
              : '字幕提取正在进行中，稍后自动加载',
          });
          return;
        }

        // 原生 API 路径：index 为原生字幕数组下标（embedded-tracks 返回 native=true）
        if (req.query.native === '1') {
          const mount = await findMountForMovie(movie);
          const nativeClient = mount ? createNativeApiFromMount(mount) : null;
          if (!nativeClient || !movie.path) {
            res.status(400).json({ success: false, message: '该影片缺少原生 API 挂载配置' });
            return;
          }
          const assets = await nativeClient.subtitleAssets(movie.path);
          const sub = assets.subtitles[streamIndex];
          if (!sub) {
            res.status(400).json({ success: false, message: '未找到指定的字幕资源' });
            return;
          }
          const assetUrl = nativeClient.resolveAssetUrl(sub, assets.domain);
          if (!assetUrl) {
            res.status(400).json({ success: false, message: '字幕资源没有可用地址' });
            return;
          }
          const nativeContent = await nativeClient.fetchSubtitleText(assetUrl);
          const rawFormat = (sub.format || '').trim().toLowerCase();
          const nativeFormat =
            rawFormat === 'webvtt'
              ? 'vtt'
              : rawFormat === 'ass' || rawFormat === 'ssa'
                ? 'ass'
                : 'srt';
          res.json({
            success: true,
            content: nativeContent,
            format: nativeFormat,
            label:
              sub.name?.trim() ||
              sub.language?.trim() ||
              `字幕 ${streamIndex + 1}`,
            language: sub.language ?? null,
          });
          return;
        }

        const ctx = await resolveEmbyContext(movie);
        // subtitleProfile: 让 Emby 下发每条字幕流的 DeliveryUrl（取字幕文件的地址）
        const playback = await ctx.client.playbackInfo(ctx.itemId, ctx.userId, {
          subtitleProfile: true,
        });
        const mediaSource = playback.MediaSources[0];
        const subStream = (mediaSource?.MediaStreams ?? []).find(
          (s) => s.Type === 'Subtitle' && s.Index === streamIndex,
        );
        if (!subStream || !mediaSource) {
          res.status(400).json({ success: false, message: '未找到指定的字幕轨道' });
          return;
        }
        const { ext, format } = mapEmbySubtitleFormat(subStream.Codec || '');
        // 字幕流的「类型内序号」：部分 Emby 版本按此定位字幕，而非容器全局 Index
        const subtitleStreams = (mediaSource.MediaStreams ?? []).filter(
          (s) => s.Type === 'Subtitle',
        );
        const ordinal = subtitleStreams.findIndex((s) => s.Index === streamIndex);
        // 把整条字幕流的元信息传给客户端层：Emby 的取字幕地址随版本/投递方式变化，
        // DeliveryUrl / DeliveryMethod / 索引约定都是定位正确地址的关键
        const content = await ctx.client.subtitleContent(
          ctx.itemId,
          mediaSource.Id,
          streamIndex,
          ext,
          {
            index: subStream.Index,
            codec: subStream.Codec,
            isExternal: subStream.IsExternal,
            deliveryMethod: subStream.DeliveryMethod,
            deliveryUrl: subStream.DeliveryUrl,
          },
          {
            ordinal: ordinal >= 0 ? ordinal : undefined,
            subtitleCount: subtitleStreams.length,
            playSessionId: playback.PlaySessionId,
          },
        );
        const label = subStream.DisplayTitle || subStream.Language || `轨道 ${streamIndex}`;
        res.json({
          success: true,
          content,
          format,
          label,
          language: subStream.Language || null,
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: '该来源的内嵌字幕提取已前端化，后端不再提供提取',
      });
    } catch (err) {
      console.error('[subtitles] embedded-extract error:', err);
      const raw = err instanceof Error ? err.message : '提取内嵌字幕失败';
      // 上游限流（UHD 等第三方服务对密集请求返回 429）：明确提示可稍后重试，
      // 而不是让用户误以为「没有字幕」
      const message = /HTTP 429/.test(raw)
        ? `${raw}（媒体服务器限流，稍等 1~2 分钟再试即可）`
        : raw;
      res.status(400).json({ success: false, message });
    }
  },
);

export default router;
