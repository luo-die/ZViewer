/**
 * 浏览器直连射手网（assrt.net）的备用通道。
 *
 * 为什么需要：部分服务器出网受限（连不上 api.assrt.net），但用户浏览器可以
 * 直连（该 API 返回 Access-Control-Allow-Origin: *，允许跨域）。此时后端把
 * token 交给前端，由浏览器完成搜索 / 取文件列表 / 下载，服务器不参与网络请求。
 *
 * 解析与匹配逻辑与后端 services/online-subtitles.ts 保持一致。
 */

const API_BASE = 'https://api.assrt.net/v1'

export interface AssrtCandidate {
  id: number
  title: string
  videoName?: string
  format?: string
  language?: string
  score?: number
  uploadTime?: string
}

export interface AssrtFile {
  index: number
  name: string
  size?: string
  url?: string
}

interface AssrtSub {
  id?: unknown
  fileid?: unknown
  native_name?: unknown
  m_title?: unknown
  m_version?: unknown
  videoname?: unknown
  m_videoname?: unknown
  sub_name?: unknown
  lang?: { desc?: unknown }
  m_lang?: unknown
  subtype?: unknown
  m_subtype?: unknown
  vote_score?: unknown
  score?: unknown
  upload_time?: unknown
  uploadtime?: unknown
}

function unwrap(payload: unknown): Record<string, unknown> {
  const obj = payload as { status?: number; sub?: unknown } | null
  if (!obj || typeof obj !== 'object') throw new Error('射手网返回格式异常')
  if (obj.status !== 0) {
    throw new Error('射手网返回错误（status=' + String(obj.status) + '）')
  }
  return (obj.sub ?? {}) as Record<string, unknown>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 搜索字幕条目（浏览器直连） */
export async function searchAssrtDirect(
  keyword: string,
  token: string,
  limit = 15
): Promise<AssrtCandidate[]> {
  const url =
    API_BASE +
    '/sub/search?q=' +
    encodeURIComponent(keyword) +
    '&pos=0&cnt=' +
    Math.min(30, Math.max(1, limit)) +
    '&token=' +
    encodeURIComponent(token)
  const res = await fetch(url)
  if (!res.ok) throw new Error('射手网请求失败：HTTP ' + res.status)
  const sub = unwrap(await res.json())
  const subs = Array.isArray(sub.subs) ? (sub.subs as AssrtSub[]) : []
  const out: AssrtCandidate[] = []
  for (const item of subs) {
    const id = Number(item.id ?? item.fileid ?? 0)
    const title =
      str(item.native_name) ||
      str(item.m_title) ||
      str(item.m_version) ||
      str(item.videoname) ||
      str(item.sub_name)
    if (!id || !title) continue
    const rawFormat = str(item.m_subtype) || str(item.subtype)
    const rawScore = item.vote_score ?? item.score
    const score =
      typeof rawScore === 'number'
        ? rawScore
        : typeof rawScore === 'string' && rawScore.trim() !== ''
          ? Number(rawScore)
          : undefined
    out.push({
      id,
      title,
      videoName: str(item.videoname) || str(item.m_videoname) || str(item.m_version) || undefined,
      format: /^\d+$/.test(rawFormat) ? str(item.m_subtype) || undefined : rawFormat || undefined,
      language:
        (item.lang && typeof item.lang.desc === 'string' ? item.lang.desc.trim() : '') ||
        str(item.m_lang) ||
        undefined,
      score: Number.isFinite(score) ? score : undefined,
      uploadTime: str(item.upload_time) || str(item.uploadtime) || undefined,
    })
  }
  return out
}

/** 列出某条字幕的文件（浏览器直连） */
export async function listAssrtFilesDirect(
  id: number,
  token: string
): Promise<{ files: AssrtFile[]; title?: string }> {
  const url = API_BASE + '/sub/detail?id=' + id + '&token=' + encodeURIComponent(token)
  const res = await fetch(url)
  if (!res.ok) throw new Error('射手网请求失败：HTTP ' + res.status)
  const sub = unwrap(await res.json())
  const subs = Array.isArray(sub.subs) ? (sub.subs as Record<string, unknown>[]) : []
  const entry = subs[0] ?? {}
  const list = Array.isArray(entry.filelist)
    ? (entry.filelist as Record<string, unknown>[])
    : []
  const files: AssrtFile[] = []
  list.forEach((f, index) => {
    const name = str(f.f)
    if (!name) return
    files.push({
      index,
      name,
      size: str(f.s) || undefined,
      url: str(f.url) || undefined,
    })
  })
  return { files, title: str(entry.filename) || undefined }
}

/** 下载字幕文件文本（自动处理 UTF-8 / GBK） */
export async function fetchAssrtFileText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('字幕文件下载失败：HTTP ' + res.status)
  const buffer = await res.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

/** 从影片标题提取搜索关键词（与后端一致） */
export function buildSearchKeyword(title: string, path?: string | null): string {
  let text = (title || path || '').trim()
  text = text.replace(/\.(mkv|mp4|avi|ts|m2ts|rmvb|flv|wmv|mov)$/i, '')
  const cutMarkers = [
    /S\d{1,2}E\d{1,3}/i,
    /第\s*\d{1,3}\s*[集话話]/,
    /\s-\s*\d{1,3}(?:\s|$)/,
    /\[\d{1,3}(?:v\d)?\]/,
  ]
  for (const marker of cutMarkers) {
    const idx = text.search(marker)
    if (idx > 1) {
      text = text.slice(0, idx)
      break
    }
  }
  text = text.replace(/\[[^\]]*\]/g, ' ')
  text = text.replace(/【[^】]*】/g, ' ')
  text = text.replace(
    /\b(1080p|2160p|720p|4k|uhd|web-?dl|webrip|bluray|bdrip|hdtv|x264|x265|hevc|h264|10bit|8bit|aac|flac|opus|dts|vcb|vcb-studio|ma10p|repack|v2)\b/gi,
    ' '
  )
  text = text.replace(/[._]/g, ' ')
  text = text.replace(/[\s-]+[a-z0-9]{2,12}$/i, (m) =>
    /[\u4e00-\u9fff]/.test(m) ? m : ' '
  )
  text = text.replace(/\s+/g, ' ').trim()
  text = text
    .replace(/^[\s\-–—:：!！?？,，.。、]+/, '')
    .replace(/[\s\-–—:：!！?？,，.。、]+$/, '')
  return text.trim()
}

/** 提取季数 */
export function extractSeasonNumber(title: string, path?: string | null): number | null {
  const text = (title || '') + ' ' + (path || '')
  const patterns = [
    /S(\d{1,2})E\d{1,3}/i,
    /第\s*([0-9一二三四五六七八九十]{1,3})\s*[季期]/,
    /(\d{1,2})(?:st|nd|rd|th)\s*season/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\b/i,
  ]
  const cn: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  }
  for (const re of patterns) {
    const m = re.exec(text)
    if (!m) continue
    const raw = m[1] ?? ''
    const n = cn[raw] ?? Number(raw)
    if (Number.isFinite(n) && n > 0 && n < 50) return n
  }
  return null
}

/** 提取集数 */
export function extractEpisodeNumber(title: string, path?: string | null): number | null {
  const text = (title || '') + ' ' + (path || '')
  const patterns = [
    /S\d{1,2}E(\d{1,3})/i,
    /\bE(?:P)?(\d{1,3})\b/i,
    /第\s*(\d{1,3})\s*[集话話]/,
    /\[(\d{1,3})\s*(?:v\d)?\]/,
    /\s-\s*(\d{1,3})(?:\s|$|\.)/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > 0 && n < 1000) return n
    }
  }
  return null
}

/** 标题相似度（2-gram 覆盖率） */
export function titleSimilarity(query: string, candidate: string): number {
  const norm = (s: string): string =>
    (s || '').toLowerCase().replace(/[()[\]【】{}<>《》「」!！?？,，.。:：;；\-—_"\s]/g, '')
  const a = norm(query)
  const b = norm(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  if (b.includes(a) || a.includes(b)) return 0.9
  const grams = new Set<string>()
  for (let i = 0; i + 2 <= a.length; i++) grams.add(a.slice(i, i + 2))
  if (grams.size === 0) return 0
  let hit = 0
  for (const g of grams) if (b.includes(g)) hit++
  return hit / grams.size
}

/** 挑选与集数匹配的文件（优先简体、优先 ass） */
export function pickFileForEpisode(
  files: AssrtFile[],
  episode: number | null
): AssrtFile | null {
  if (files.length === 0) return null
  const score = (file: AssrtFile): number => {
    const name = file.name.toLowerCase()
    let s = 0
    if (episode != null) {
      const padded = String(episode).padStart(2, '0')
      if (
        name.includes('[' + episode + ']') ||
        name.includes('[' + padded + ']') ||
        name.includes('e' + padded) ||
        name.includes('第' + episode + '集') ||
        name.includes('第' + episode + '话')
      ) {
        s += 100
      }
    }
    if (name.includes('chs') || name.includes('简')) s += 20
    if (name.includes('cht') || name.includes('繁')) s += 5
    if (name.endsWith('.ass') || name.endsWith('.ssa')) s += 5
    if (name.endsWith('.srt')) s += 3
    return s
  }
  return [...files].sort((a, b) => score(b) - score(a))[0] ?? null
}

/** 候选排序：标题相似度 + 评分 + 语言 + 季数校验 */
export function rankAssrtCandidates(
  keyword: string,
  candidates: AssrtCandidate[],
  season: number | null
): AssrtCandidate[] {
  return candidates
    .map((c) => {
      let score =
        titleSimilarity(keyword, c.title) * 100 +
        titleSimilarity(keyword, c.videoName ?? '') * 40 +
        (c.score ?? 0) / 20 +
        (/简/.test(c.language ?? '') ? 10 : 0)
      const candSeason = extractSeasonNumber(c.title, c.videoName ?? '')
      if (season != null && candSeason != null && season !== candSeason) score -= 200
      else if (season != null && candSeason == null) score -= 20
      return { c, score }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
}
