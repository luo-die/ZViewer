/**
 * 在线字幕服务（射手网 assrt.net）
 *
 * 用途：媒体服务器（Emby/Jellyfin）没有内嵌/外挂字幕时作为保底——
 * 按影片标题搜索 assrt，匹配集数后直接取单集字幕文件（assrt 的 filelist
 * 提供逐集直链，无需解压 zip）。
 *
 * Token：仅从系统设置（管理员在后台填写）或环境变量 ASSRT_TOKEN 读取，
 * 绝不写入源码 / 版本库。
 *
 * 网络层用 node:http(s) 而不是 fetch：可显式指定 family=4，避免「DNS 先返回
 * AAAA 但服务器没有 IPv6 出口」导致的 fetch failed；且 fetch 的报错没有可
 * 诊断信息，node:http 能拿到 err.code。
 */
import http from 'node:http';
import https from 'node:https';
import { getSystemSettings } from './system-settings';

const API_BASE = 'https://api.assrt.net/v1';
/** API 请求超时（射手网偶尔较慢） */
const REQUEST_TIMEOUT_MS = 30_000;
/** 字幕文件下载超时 */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const USER_AGENT = 'ZViewer/1.0 (+https://github.com/luo-die/ZViewer)';

export interface AssrtCandidate {
  id: number;
  /** 字幕标题（native_name / m_title） */
  title: string;
  /** 视频名（部分条目提供） */
  videoName?: string;
  /** 字幕格式（如 SSA / Subrip(srt)） */
  format?: string;
  /** 语言描述（如 "简 繁"） */
  language?: string;
  /** 评分 */
  score?: number;
  uploadTime?: string;
}

export interface AssrtFile {
  /** 在 filelist 中的下标（下载时回传） */
  index: number;
  name: string;
  size?: string;
  /** 直链（内部使用，路由响应里会剔除） */
  url?: string;
}

export interface AssrtSubtitleContent {
  content: string;
  /** ass / srt / vtt */
  format: 'ass' | 'srt' | 'vtt';
  name: string;
}

interface RawResponse {
  status: number;
  body: Buffer;
}

/** 把底层网络错误转成可读信息 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return code ? code + ' (' + err.message + ')' : err.message;
}

/** 可选代理：ASSRT_PROXY（如 http://127.0.0.1:7890），用于服务器直连受限的环境 */
function getProxyUrl(): URL | null {
  const raw = (process.env.ASSRT_PROXY ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/** 通过 HTTP 代理建立到目标主机的隧道（https 走 CONNECT，http 直发） */
function proxyGet(
  target: URL,
  proxy: URL,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const targetPort = target.port || (target.protocol === 'http:' ? '80' : '443');
    const proxyMod = proxy.protocol === 'https:' ? https : http;
    const connectReq = proxyMod.request({
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: target.hostname + ':' + targetPort,
      timeout: timeoutMs,
      headers: {
        Host: target.hostname + ':' + targetPort,
        ...(proxy.username
          ? {
              'Proxy-Authorization':
                'Basic ' +
                Buffer.from(
                  decodeURIComponent(proxy.username) +
                    ':' +
                    decodeURIComponent(proxy.password),
                ).toString('base64'),
            }
          : {}),
      },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('代理 CONNECT 失败：HTTP ' + res.statusCode));
        return;
      }
      const inner = target.protocol === 'http:' ? http : https;
      const req = inner.request(
        {
          // 已通过 CONNECT 建立隧道：直接复用 socket，不再传 host/port
          createConnection: () => socket,
          path: target.pathname + target.search,
          method: 'GET',
          headers,
          timeout: timeoutMs,
          ...(target.protocol === 'https:' ? { servername: target.hostname } : {}),
        },
        (res2) => {
          const status = res2.statusCode ?? 0;
          const location = res2.headers.location;
          if (status >= 300 && status < 400 && location) {
            res2.resume();
            socket.destroy();
            resolve(
              rawGet(new URL(location, target.toString()).toString(), headers, timeoutMs, 4),
            );
            return;
          }
          const chunks: Buffer[] = [];
          res2.on('data', (c: Buffer) => chunks.push(c));
          res2.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
          res2.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      req.end();
    });
    connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}

/** 发起 GET 请求并返回原始字节（支持重定向、可指定 IP 协议族） */
function rawGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  family: 4 | 0,
  redirects = 3,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('无效的 URL：' + url));
      return;
    }
    const isHttp = parsed.protocol === 'http:';
    const mod = isHttp ? http : https;
    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttp ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
        ...(family === 4 ? { family: 4 as const } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          resolve(
            rawGet(
              new URL(location, url).toString(),
              headers,
              timeoutMs,
              family,
              redirects - 1,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 先按 IPv4 直连，失败再按系统默认解析重试一次 */
async function requestWithFallback(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<RawResponse> {
  // 配了代理就优先走代理（服务器直连受限时唯一的出路）
  const proxy = getProxyUrl();
  if (proxy) {
    try {
      return await proxyGet(new URL(url), proxy, headers, timeoutMs);
    } catch (err) {
      throw new Error('射手网连接失败（经代理 ' + proxy.host + '）：' + describeError(err));
    }
  }
  try {
    return await rawGet(url, headers, timeoutMs, 4);
  } catch {
    try {
      return await rawGet(url, headers, timeoutMs, 0);
    } catch (err2) {
      throw new Error('射手网连接失败：' + describeError(err2));
    }
  }
}

/** 出网连通性自检：逐个探测候选主机，报告可达性与耗时 */
export async function probeOutboundHosts(): Promise<
  { name: string; url: string; ok: boolean; status?: number; ms: number; error?: string }[]
> {
  const targets: { name: string; url: string }[] = [
    { name: '射手网 API', url: 'https://api.assrt.net/v1/sub/search?q=test&pos=0&cnt=1' },
    { name: '射手网文件', url: 'https://file1.assrt.net/' },
    { name: 'GitHub API', url: 'https://api.github.com/' },
    { name: 'B站 API', url: 'https://api.bilibili.com/x/web-interface/nav' },
    { name: '百度', url: 'https://www.baidu.com/' },
    { name: 'SubHD', url: 'https://subhd.cc/' },
    { name: 'UHD 媒体服务器', url: 'https://v1.uhdnow.com/' },
  ];
  const results = await Promise.all(
    targets.map(async (t) => {
      const started = Date.now();
      try {
        const res = await rawGet(t.url, { 'User-Agent': USER_AGENT }, 6_000, 4);
        return {
          name: t.name,
          url: t.url,
          ok: res.status > 0 && res.status < 500,
          status: res.status,
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          name: t.name,
          url: t.url,
          ok: false,
          ms: Date.now() - started,
          error: describeError(err),
        };
      }
    }),
  );
  return results;
}

/** 读取 assrt token：系统设置优先，其次环境变量 */
export async function getAssrtToken(): Promise<string> {
  try {
    const settings = await getSystemSettings();
    const fromSettings = (settings.assrtToken ?? '').trim();
    if (fromSettings) return fromSettings;
  } catch {
    /* 读设置失败时回退环境变量 */
  }
  return (process.env.ASSRT_TOKEN ?? '').trim();
}

async function assrtGetJson(url: string): Promise<unknown> {
  const res = await requestWithFallback(
    url,
    { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    REQUEST_TIMEOUT_MS,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error('射手网请求失败：HTTP ' + res.status);
  }
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new Error('射手网返回内容不是 JSON');
  }
}

/** 解析 assrt 响应外壳，返回 sub 字段 */
function unwrap(payload: unknown): Record<string, unknown> {
  const obj = payload as { status?: number; sub?: unknown } | null;
  if (!obj || typeof obj !== 'object') throw new Error('射手网返回格式异常');
  if (obj.status !== 0) {
    throw new Error('射手网返回错误（status=' + String(obj.status) + '）');
  }
  return (obj.sub ?? {}) as Record<string, unknown>;
}

/** 按关键词搜索字幕条目 */
export async function searchAssrt(
  keyword: string,
  options: { token?: string; limit?: number } = {},
): Promise<AssrtCandidate[]> {
  const token = options.token ?? (await getAssrtToken());
  if (!token) throw new Error('未配置射手网 API Token');
  const q = keyword.trim();
  if (!q) return [];
  const limit = Math.min(30, Math.max(1, options.limit ?? 15));
  const url =
    API_BASE +
    '/sub/search?q=' +
    encodeURIComponent(q) +
    '&pos=0&cnt=' +
    limit +
    '&token=' +
    encodeURIComponent(token);
  const sub = unwrap(await assrtGetJson(url));
  const subs = Array.isArray(sub.subs) ? (sub.subs as Record<string, unknown>[]) : [];
  const out: AssrtCandidate[] = [];
  for (const item of subs) {
    // 射手网同一接口会返回两套字段名（旧版 id/native_name/lang，新版 fileid/m_version/m_lang）
    const id = Number(item.id ?? item.fileid ?? 0);
    const title = String(
      item.native_name ?? item.m_title ?? item.m_version ?? item.videoname ?? item.sub_name ?? '',
    ).trim();
    if (!id || !title) continue;
    const lang = item.lang as { desc?: string } | undefined;
    const language =
      (lang && typeof lang.desc === 'string' ? lang.desc.trim() : '') ||
      String(item.m_lang ?? '').trim() ||
      undefined;
    const rawFormat = String(item.m_subtype ?? item.subtype ?? '').trim();
    const format = /^\d+$/.test(rawFormat)
      ? String(item.m_subtype ?? '').trim() || undefined
      : rawFormat || undefined;
    const rawScore = item.vote_score ?? item.score;
    const score =
      typeof rawScore === 'number'
        ? rawScore
        : typeof rawScore === 'string' && rawScore.trim() !== ''
          ? Number(rawScore)
          : undefined;
    out.push({
      id,
      title,
      videoName:
        String(item.videoname ?? item.m_videoname ?? item.m_version ?? '').trim() ||
        undefined,
      format,
      language,
      score: Number.isFinite(score) ? score : undefined,
      uploadTime:
        String(item.upload_time ?? item.uploadtime ?? '').trim() || undefined,
    });
  }
  return out;
}

/** 列出某条字幕包含的文件（逐集直链） */
export async function listAssrtFiles(
  id: number,
  options: { token?: string } = {},
): Promise<{ files: AssrtFile[]; zipUrl?: string; title?: string }> {
  const token = options.token ?? (await getAssrtToken());
  if (!token) throw new Error('未配置射手网 API Token');
  const url = API_BASE + '/sub/detail?id=' + id + '&token=' + encodeURIComponent(token);
  const sub = unwrap(await assrtGetJson(url));
  const subs = Array.isArray(sub.subs) ? (sub.subs as Record<string, unknown>[]) : [];
  const entry = subs[0] ?? {};
  const list = Array.isArray(entry.filelist)
    ? (entry.filelist as Record<string, unknown>[])
    : [];
  const files: AssrtFile[] = [];
  list.forEach((f, index) => {
    const name = String(f.f ?? '').trim();
    if (!name) return;
    files.push({
      index,
      name,
      size: String(f.s ?? '').trim() || undefined,
      url: String(f.url ?? '').trim() || undefined,
    });
  });
  return {
    files,
    zipUrl: typeof entry.url === 'string' ? entry.url : undefined,
    title: typeof entry.filename === 'string' ? entry.filename : undefined,
  };
}

/** 取文件直链（内部使用） */
async function resolveFileUrl(
  id: number,
  index: number,
  token: string,
): Promise<{ url: string; name: string }> {
  const url = API_BASE + '/sub/detail?id=' + id + '&token=' + encodeURIComponent(token);
  const sub = unwrap(await assrtGetJson(url));
  const subs = Array.isArray(sub.subs) ? (sub.subs as Record<string, unknown>[]) : [];
  const list = Array.isArray(subs[0]?.filelist)
    ? (subs[0]!.filelist as Record<string, unknown>[])
    : [];
  const target = list[index];
  if (!target) throw new Error('射手网未返回该字幕文件');
  const fileUrl = String(target.url ?? '').trim();
  const name = String(target.f ?? '').trim() || 'subtitle-' + id + '-' + index;
  if (!fileUrl) throw new Error('射手网未提供该字幕文件的下载地址');
  return { url: fileUrl, name };
}

/** 按文件名推断字幕格式 */
function formatFromName(name: string): 'ass' | 'srt' | 'vtt' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass';
  if (lower.endsWith('.vtt')) return 'vtt';
  return 'srt';
}

/**
 * 解码字幕文本：assrt 的 .ass/.srt 可能是 UTF-8，也可能是 GBK。
 * UTF-8 解码出现替换字符时改按 GBK 再试一次。
 */
function decodeSubtitle(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/** 下载并返回字幕内容 */
export async function fetchAssrtSubtitle(
  id: number,
  index: number,
  options: { token?: string; directUrl?: string; directName?: string } = {},
): Promise<AssrtSubtitleContent> {
  const token = options.token ?? (await getAssrtToken());
  if (!token) throw new Error('未配置射手网 API Token');
  // 已有直链（自动匹配路径已取过 filelist）时跳过重复的 detail 请求
  const resolved = options.directUrl
    ? {
        url: options.directUrl,
        name: options.directName ?? 'subtitle-' + id + '-' + index,
      }
    : await resolveFileUrl(id, index, token);
  const res = await requestWithFallback(
    resolved.url,
    {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Referer: 'https://assrt.net/',
    },
    DOWNLOAD_TIMEOUT_MS,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error('字幕文件下载失败：HTTP ' + res.status);
  }
  const content = decodeSubtitle(res.body);
  if (!content.trim()) throw new Error('字幕文件内容为空');
  return { content, format: formatFromName(resolved.name), name: resolved.name };
}

/** 从影片标题里提取用于搜索的关键词（去掉扩展名、集数标记与压制/画质标记） */
export function buildSearchKeyword(title: string, path?: string | null): string {
  let text = (title || path || '').trim();
  text = text.replace(/\.(mkv|mp4|avi|ts|m2ts|rmvb|flv|wmv|mov)$/i, '');
  // 截断到集数标记之前：标题主体通常在「S01E01 / 第01集 / - 01」之前
  const cutMarkers = [
    /S\d{1,2}E\d{1,3}/i,
    /第\s*\d{1,3}\s*[集话話]/,
    /\s-\s*\d{1,3}(?:\s|$)/,
    /\[\d{1,3}(?:v\d)?\]/,
  ];
  for (const marker of cutMarkers) {
    const idx = text.search(marker);
    if (idx > 1) {
      text = text.slice(0, idx);
      break;
    }
  }
  text = text.replace(/\[[^\]]*\]/g, ' ');
  text = text.replace(/【[^】]*】/g, ' ');
  text = text.replace(
    /\b(1080p|2160p|720p|4k|uhd|web-?dl|webrip|bluray|bdrip|hdtv|x264|x265|hevc|h264|10bit|8bit|aac|flac|opus|dts|vcb|vcb-studio|ma10p|repack|v2)\b/gi,
    ' ',
  );
  text = text.replace(/[._]/g, ' ');
  // 去掉纯 ASCII 的短词尾巴（压制组名等，如 "-Studio"）
  text = text.replace(/[\s-]+[a-z0-9]{2,12}$/i, (m) =>
    /[\u4e00-\u9fff]/.test(m) ? m : ' ',
  );
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/^[\s\-–—:：!！?？,，.。、]+/, '').replace(/[\s\-–—:：!！?？,，.。、]+$/, '');
  return text.trim();
}

/** 从标题里提取季数（1 开始；无法判断时返回 null） */
export function extractSeasonNumber(
  title: string,
  path?: string | null,
): number | null {
  const text = (title || '') + ' ' + (path || '');
  const patterns = [
    /S(\d{1,2})E\d{1,3}/i,
    /第\s*([0-9一二三四五六七八九十]{1,3})\s*[季期]/,
    /(\d{1,2})(?:st|nd|rd|th)\s*season/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\b/i,
  ];
  const cnDigits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = m[1] ?? '';
    const n = cnDigits[raw] ?? Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 50) return n;
  }
  return null;
}

/** 从影片标题里提取集数（1 开始；无法判断时返回 null） */
export function extractEpisodeNumber(
  title: string,
  path?: string | null,
): number | null {
  const text = (title || '') + ' ' + (path || '');
  const patterns = [
    /S\d{1,2}E(\d{1,3})/i,
    /\bE(?:P)?(\d{1,3})\b/i,
    /第\s*(\d{1,3})\s*[集话話]/,
    /\[(\d{1,3})\s*(?:v\d)?\]/,
    /\s-\s*(\d{1,3})(?:\s|$|\.)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 1000) return n;
    }
  }
  return null;
}

/** 在文件列表中挑选与集数匹配的文件（优先简体、优先 .ass） */
export function pickFileForEpisode(
  files: AssrtFile[],
  episode: number | null,
): AssrtFile | null {
  if (files.length === 0) return null;
  const score = (file: AssrtFile): number => {
    const name = file.name.toLowerCase();
    let s = 0;
    if (episode != null) {
      const padded = String(episode).padStart(2, '0');
      if (
        name.includes('[' + episode + ']') ||
        name.includes('[' + padded + ']') ||
        name.includes('e' + padded) ||
        name.includes('第' + episode + '集') ||
        name.includes('第' + episode + '话')
      ) {
        s += 100;
      }
    }
    if (name.includes('chs') || name.includes('简')) s += 20;
    if (name.includes('cht') || name.includes('繁')) s += 5;
    if (name.endsWith('.ass') || name.endsWith('.ssa')) s += 5;
    if (name.endsWith('.srt')) s += 3;
    return s;
  };
  const sorted = [...files].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}
