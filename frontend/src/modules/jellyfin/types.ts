/**
 * Jellyfin 挂载类型定义
 *
 * Jellyfin 是 Emby 开源分支，同为媒体库型（itemId 树形结构）。
 * 认证方式二选一：API Key 或 账号密码。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface JellyfinMount {
  id: number
  type: 'jellyfin'
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  embyUserId: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface JellyfinMountFormPayload {
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface JellyfinTestResult {
  success: boolean
  userId?: string
  userName?: string
  serverId?: string
}

import type { EmbyDirectoryEntry } from '@/modules/emby/types'

/**
 * Jellyfin 条目结构 = Emby 条目结构
 *
 * 两者接口完全兼容，浏览组件（EmbyBrowser）与条目类型共用一份定义，
 * 避免新增字段（缩略图、集序号）时两处不同步。
 */
export type JellyfinDirectoryEntry = EmbyDirectoryEntry

export interface JellyfinResolvedSource {
  title: string
  videoUrl: string
  /** 直连 URL（浏览器可直连 Jellyfin 时使用） */
  directUrl?: string
  format: MediaFormat
  duration: number
  /** 默认音轨编码（如 aac/dts/eac3），无法探测时为 null */
  audioCodec?: string | null
  /** 音轨编码浏览器不支持，已自动切换为 Jellyfin 服务端转码流（HLS） */
  needsAudioTranscode?: boolean
  /** 音轨不兼容但管理后台音频转码开关关闭，浏览器可能无声 */
  audioTranscodeDisabled?: boolean
}
