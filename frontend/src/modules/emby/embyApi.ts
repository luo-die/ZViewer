/**
 * Emby API 层
 *
 * 与 webdav/openlist/ftp 挂载 API 结构对齐，路由前缀 /api/emby。
 */
import { apiFetch } from '@/lib/api'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import { appendAuthToken } from '@/modules/player/services/url-proxy'
import type { MediaFormat } from '@/lib/mediaFormat'
import type {
  EmbyMount,
  EmbyMountFormPayload,
  EmbyTestResult,
  EmbyDirectoryEntry,
  EmbyResolvedSource,
} from './types'

/** 媒体库挂载类型（Emby / Jellyfin 共用同一套浏览与图片代理接口） */
export type LibraryModule = 'emby' | 'jellyfin'

/**
 * 后端 /browse、/search、/episodes 返回的原始条目。
 * 比前端条目多一个 imageTag（图片版本标识），由本层拼成 imageUrl。
 */
interface RawLibraryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  embyType?: string
  childCount?: number
  imageTag?: string | null
  imageAspectRatio?: number | null
  indexNumber?: number | null
  parentIndexNumber?: number | null
  seriesName?: string | null
  productionYear?: number | null
  runtimeTicks?: number | null
}

/**
 * 缩略图地址（本站图片代理，需鉴权）。
 *
 * 为什么要走代理：Emby/Jellyfin 的图片端点需要 api_key，而 <img> 无法设置请求头；
 * 由后端带 token 取图后中转，前端不直连媒体服务器（内网 Emby 也能显示缩略图）。
 * tag 拼在 URL 里，图片变更后缓存自动失效。
 */
export function buildLibraryImageUrl(
  module: LibraryModule,
  mountId: number,
  entry: { path: string; imageTag?: string | null },
  opts?: { type?: string; maxWidth?: number; maxHeight?: number }
): string | undefined {
  if (!entry.imageTag) return undefined
  const params = new URLSearchParams({
    itemId: entry.path,
    tag: entry.imageTag,
    type: opts?.type ?? 'Primary',
    maxWidth: String(opts?.maxWidth ?? 200),
    maxHeight: String(opts?.maxHeight ?? 300),
  })
  return appendAuthToken(
    `/api/${module}/mounts/${mountId}/image?${params.toString()}`
  )
}

/** 原始条目 → 前端条目（补上缩略图地址） */
export function decorateLibraryEntries(
  module: LibraryModule,
  mountId: number,
  raw: RawLibraryEntry[]
): EmbyDirectoryEntry[] {
  return raw.map((entry) => ({
    ...entry,
    imageUrl: buildLibraryImageUrl(module, mountId, entry),
  }))
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export async function getEmbyMounts(): Promise<EmbyMount[]> {
  const res = await apiFetch('/api/emby/mounts')
  const data = (await res.json()) as {
    success: boolean
    mounts?: EmbyMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 Emby 挂载列表失败')
  }
  return data.mounts || []
}

export async function createEmbyMount(
  payload: EmbyMountFormPayload
): Promise<EmbyMount & { warning?: string }> {
  const res = await apiFetch('/api/emby/mounts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: EmbyMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 Emby 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function updateEmbyMount(
  id: number,
  payload: EmbyMountFormPayload
): Promise<EmbyMount & { warning?: string }> {
  const res = await apiFetch(`/api/emby/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: EmbyMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 Emby 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function deleteEmbyMount(id: number): Promise<void> {
  const res = await apiFetch(`/api/emby/mounts/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 Emby 挂载失败')
  }
}

export async function testEmbyMount(
  payload: EmbyMountFormPayload
): Promise<EmbyTestResult> {
  const res = await apiFetch('/api/emby/mounts/test', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    userId?: string
    userName?: string
    serverId?: string
    message?: string
    code?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '测试 Emby 连接失败')
  }
  return {
    success: true,
    userId: data.userId,
    userName: data.userName,
    serverId: data.serverId,
  }
}

export async function browseEmbyMount(
  id: number,
  path?: string
): Promise<EmbyDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/api/emby/mounts/${id}/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: RawLibraryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 Emby 挂载失败')
  }
  return decorateLibraryEntries('emby', id, data.entries || [])
}

/**
 * 收集季 / 剧集下的全部可播放单集（「整季添加」用）。
 * 后端递归展开并按季号、集号排序，前端一次拿到可直接批量添加的列表。
 */
export async function fetchEmbyEpisodes(
  id: number,
  path: string,
  limit?: number
): Promise<EmbyDirectoryEntry[]> {
  const params = new URLSearchParams({ path })
  if (limit != null) params.set('limit', String(limit))
  const res = await apiFetch(
    `/api/emby/mounts/${id}/episodes?${params.toString()}`
  )
  const data = (await res.json()) as {
    success: boolean
    entries?: RawLibraryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 Emby 剧集列表失败')
  }
  return decorateLibraryEntries('emby', id, data.entries || [])
}

/**
 * 搜索 Emby 媒体库（递归，跨全部媒体库）。
 * 用于挂载后直接按名称检索资源库，无需逐级点进媒体库/剧集/季。
 */
export async function searchEmbyMount(
  id: number,
  query: string,
  limit?: number
): Promise<EmbyDirectoryEntry[]> {
  const params = new URLSearchParams({ q: query })
  if (limit != null) params.set('limit', String(limit))
  const res = await apiFetch(
    `/api/emby/mounts/${id}/search?${params.toString()}`
  )
  const data = (await res.json()) as {
    success: boolean
    entries?: RawLibraryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '搜索 Emby 媒体库失败')
  }
  return decorateLibraryEntries('emby', id, data.entries || [])
}

export async function resolveEmby(
  mountId: number,
  path: string
): Promise<EmbyResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/emby/resolve?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    directUrl?: string
    format?: MediaFormat
    duration?: number
    audioCodec?: string | null
    needsAudioTranscode?: boolean
    audioTranscodeDisabled?: boolean
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 Emby 条目失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    directUrl: data.directUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    audioCodec: data.audioCodec ?? null,
    needsAudioTranscode: data.needsAudioTranscode === true,
    audioTranscodeDisabled: data.audioTranscodeDisabled === true,
  }
}

export function buildEmbyProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('emby', { mountId, path })
}
