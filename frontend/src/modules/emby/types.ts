/**
 * Emby 挂载类型定义
 *
 * Emby 是媒体库型视频源（itemId 树形结构，非文件目录型），
 * 认证方式二选一：API Key 或 账号密码。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface EmbyMount {
  id: number
  type: 'emby'
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  embyUserId: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface EmbyMountFormPayload {
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface EmbyTestResult {
  success: boolean
  userId?: string
  userName?: string
  serverId?: string
}

export interface EmbyDirectoryEntry {
  name: string
  path: string
  /** file = 可播放条目（电影/单集），directory = 可继续浏览（媒体库/剧集/季） */
  type: 'file' | 'directory'
  /** Emby 条目类型（CollectionFolder/Series/Season/Movie/Episode/Video） */
  embyType?: string
  childCount?: number
  /**
   * 缩略图地址（本站 /api/emby/mounts/:id/image 代理，已带鉴权 token）。
   * 由 API 层根据后端下发的 imageTag 拼装；条目无主图时为 undefined。
   */
  imageUrl?: string
  /** 主图宽高比（0.6667≈2:3 海报，1.7778≈16:9 剧照），用于选择缩略图展示比例 */
  imageAspectRatio?: number | null
  /** 集序号（单集/季） */
  indexNumber?: number | null
  /** 所属季序号（单集的 ParentIndexNumber） */
  parentIndexNumber?: number | null
  /** 所属剧集名（单集的 SeriesName） */
  seriesName?: string | null
  /** 发行年份 */
  productionYear?: number | null
  /** 时长（100ns tick，除以 1e7 得秒） */
  runtimeTicks?: number | null
}

/** 浏览框选中条目回传（路径 + 可读名称，用于批量添加时生成影片标题） */
export interface SelectedLibraryEntry {
  path: string
  name: string
}

export interface EmbyResolvedSource {
  title: string
  videoUrl: string
  /** 直连 URL（浏览器可直连 Emby 时使用） */
  directUrl?: string
  format: MediaFormat
  duration: number
  /** 默认音轨编码（如 aac/dts/eac3），无法探测时为 null */
  audioCodec?: string | null
  /** 音轨编码浏览器不支持，已自动切换为 Emby 服务端转码流（HLS） */
  needsAudioTranscode?: boolean
  /** 音轨不兼容但管理后台音频转码开关关闭，浏览器可能无声 */
  audioTranscodeDisabled?: boolean
}
