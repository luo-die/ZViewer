/**
 * 在线字幕服务（射手网 assrt.net）
 *
 * 用途：媒体服务器（Emby/Jellyfin）没有内嵌/外挂字幕时作为保底——
 * 按影片标题搜索 assrt，匹配集数后直接取单集字幕文件（assrt 的 filelist
 * 提供逐集直链，无需解压 zip）。
 *
 * Token：仅从系统设置（管理员在后台填写）或环境变量 ASSRT_TOKEN 读取，
 * 绝不写入源码 / 版本库。
 */
import { getSystemSettings } from './system-settings';

const API_BASE = 'https://api.assrt.net/v1';
/** API 请求超时（射手网偶尔较慢） */
const REQUEST_TIMEOUT_MS = 30_000;
/** 字幕文件下载超时 */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const USER_AGENT = 'ZViewer/1.0 (+https://github.com/luo-die/ZViewer)';

export interface AssrtCandidate {
  id: number;
  /** 字幕标题（native_name） */
  title: string;
  /** 视频名（部分条目提供） */
  videoName?: string;
  /** 字幕格式（subtype，如 SSA / Subrip(srt)） */
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

async function assrtGetOnce(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error('射手网请求失败：HTTP ' + res.status);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** 带一次重试：射手网偶发超时/抖动 */
async function assrtGet(url: string): Promise<unknown> {
  try {
    return await assrtGetOnce(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/abort|timeout|ECONN|fetch failed|HTTP 5/i.test(message)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return assrtGetOnce(url);
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
  const sub = unwrap(await assrtGet(url));
  const subs = Array.isArray(sub.subs) ? (sub.subs as Record<string, unknown>[]) : [];
  const out: AssrtCandidate[] = [];
  for (const item of subs) {
    // 射手网同一接口会返回两套字段名（旧版 id/native_name/lang，新版 fileid/m_version/m_lang），
    // 两套都要兼容。
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
  const sub = unwrap(await assrtGet(url));
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
  const sub = unwrap(await assrtGet(url));
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(resolved.url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        Referer: 'https://assrt.net/',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('字幕文件下载失败：HTTP ' + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    const content = decodeSubtitle(buffer);
    if (!content.trim()) throw new Error('字幕文件内容为空');
    return { content, format: formatFromName(resolved.name), name: resolved.name };
  } finally {
    clearTimeout(timer);
  }
}

/** 从影片标题里提取用于搜索的关键词（去掉扩展名与压制/画质标记） */
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
  text = text.replace(/[\s-]+[a-z0-9]{2,12}$/i, (m) => (/[\u4e00-\u9fff]/.test(m) ? m : ' '));
  text = text.replace(/\s+/g, ' ').trim();
  // 去掉首尾标点
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
