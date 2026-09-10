// 统一挂载类型：聚合 webdav/openlist/ftp/emby/jellyfin 五种挂载
// 各模块保持独立 CRUD，此类型仅用于统一展示和选择
import type { WebDAVMount } from '@/modules/webdav/types'
import type { OpenListMount } from '@/modules/openlist/types'
import type { FTPMount } from '@/modules/ftp/types'
import type { EmbyMount } from '@/modules/emby/types'
import type { JellyfinMount } from '@/modules/jellyfin/types'

export type MountType = 'webdav' | 'ftp' | 'openlist' | 'emby' | 'jellyfin'

/** 共享范围：selected=指定用户；all=所有登录用户 */
export type ShareScope = 'selected' | 'all'

/**
 * 挂载共享元信息。
 *
 * 由各类型 GET /mounts 一并下发（仅自己的挂载有这些字段）；
 * 「他人共享给我的挂载」走 /api/mounts/shared，见 SharedMount。
 */
export interface MountShareMeta {
  /** 是否已开启共享 */
  shareEnabled?: boolean
  /** 共享范围 */
  shareScope?: ShareScope
  /** 共享目标用户 ID（shareScope='selected' 时生效） */
  sharedUserIds?: number[]
}

export type UnionMount = (
  WebDAVMount | OpenListMount | FTPMount | EmbyMount | JellyfinMount
) &
  MountShareMeta

/**
 * 他人共享给我的挂载。
 *
 * 后端只下发非敏感字段：不含 serverUrl / path / username / password / apiKey，
 * 因此仅可用于「浏览目录 → 在房间中添加影片」。
 */
export interface SharedMount {
  id: number
  type: MountType
  name: string
  ownerUserId: number
  ownerName: string | null
  /**
   * 播放方式，与挂载主设置一致（被共享者无权更改）：
   * true=直链直连，false=服务器中转。
   */
  directLink: boolean
  shared: true
  createdAt: string
  updatedAt: string
}

/** 可访问的挂载：自己的（UnionMount）或他人共享的（SharedMount） */
export type AnyMount = UnionMount | SharedMount

export interface MountTypeMeta {
  label: string
  color: 'primary' | 'warning' | 'success'
  icon: React.ReactNode
}

/** 类型守卫 */
export function isWebDAVMount(m: AnyMount): m is WebDAVMount {
  return m.type === 'webdav'
}

export function isOpenListMount(m: AnyMount): m is OpenListMount {
  return m.type === 'openlist'
}

export function isFTPMount(m: AnyMount): m is FTPMount {
  return m.type === 'ftp'
}

export function isEmbyMount(m: AnyMount): m is EmbyMount {
  return m.type === 'emby'
}

export function isJellyfinMount(m: AnyMount): m is JellyfinMount {
  return m.type === 'jellyfin'
}

/** 是否为「他人共享给我的挂载」 */
export function isSharedMount(m: AnyMount): m is SharedMount {
  return (m as SharedMount).shared === true
}

/** 取挂载的连接信息（共享挂载没有任何连接信息，返回空） */
export function mountServerUrl(m: AnyMount): string {
  return isSharedMount(m) ? '' : m.serverUrl || ''
}

/** 取挂载的根路径（共享挂载不下发 path） */
export function mountRootPath(m: AnyMount): string {
  if (isSharedMount(m)) return ''
  return 'path' in m && m.path ? m.path : ''
}
