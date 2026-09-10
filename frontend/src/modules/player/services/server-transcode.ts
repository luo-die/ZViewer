/**
 * 服务端转码（server-side transcode）——「转码方式」的 server 档。
 *
 * 给「跑不了浏览器端转码」的客户端兜底：由后端 ffmpeg 把源重封装/转码为 HLS，
 * 前端继续用 hls.js 播放；**iPhone（含 iOS 17.1 以下）走 Safari 原生 HLS**，
 * 因此不需要 MediaSource 也能看 MKV / DTS 这类源。
 *
 * 权限与作用域（关键，与本机偏好不同）：
 * - 这是**房间级设置**（Room.transcodeMode），**只有房主能改**，全房间生效：
 *   房主开启后重新解析当前影片并把 HLS 源广播出去，观众（含 iPhone）跟着播。
 * - 观众端不提供该开关：服务端转码烧的是房主的服务器 CPU/带宽，
 *   不能让观众悄悄开启。观众设备播不了时，报错信息会提示请房主开启。
 *
 * 浏览器端转码仍是默认路径（零服务器开销），服务端转码是「iOS 兼容模式」。
 */
import { apiFetch } from '@/lib/api'
import { describePlaysVideoSupport } from '@/modules/player/engines/playsvideo-engine'
import { useRoomStore } from '@/store/roomStore'
import type { PlayerSource } from '@/modules/player/types'

export interface TranscodeCapability {
  available: boolean
  version: string | null
}

let cachedCapability: TranscodeCapability | null = null
let capabilityPromise: Promise<TranscodeCapability> | null = null

/** 查询服务端是否具备转码能力（进程内缓存一次） */
export function fetchTranscodeCapability(): Promise<TranscodeCapability> {
  if (cachedCapability) return Promise.resolve(cachedCapability)
  if (!capabilityPromise) {
    capabilityPromise = apiFetch('/api/transcode/capability')
      .then(async (res) => {
        const data = (await res.json()) as {
          success?: boolean
          available?: boolean
          version?: string | null
        }
        const capability: TranscodeCapability = {
          available: res.ok && data.success === true && data.available === true,
          version: data.version ?? null,
        }
        cachedCapability = capability
        return capability
      })
      .catch((err) => {
        console.warn('[server-transcode] 能力探测失败（按不可用处理）:', err)
        const capability: TranscodeCapability = {
          available: false,
          version: null,
        }
        cachedCapability = capability
        return capability
      })
  }
  return capabilityPromise
}

/** 已探测到的能力（同步读取；尚未探测时为 null） */
export function getCachedTranscodeCapability(): TranscodeCapability | null {
  return cachedCapability
}

/** 当前房间是否由房主开启了服务端转码 */
export function isRoomTranscodeServerMode(): boolean {
  return useRoomStore.getState().roomSettings.transcodeMode === 'server'
}

/**
 * 是否需要走服务端转码（同步判定；调用方需自行确认能力已探测为可用）。
 *
 * 只看房间设置：`server` 档且服务端具备 ffmpeg。
 * 设备能力不再参与判定——服务端转码是房主为**整个房间**（可能包含 iOS 观众）
 * 选择的播放方式，不是每台设备各自的兜底。
 */
export function shouldUseServerTranscode(): boolean {
  if (!isRoomTranscodeServerMode()) return false
  if (cachedCapability && !cachedCapability.available) return false
  return true
}

/** 转码方式：浏览器解不了视频编码时需要重编码，否则只需重封装 */
export function pickTranscodeMode(source: PlayerSource): 'remux' | 'transcode' {
  const video = (source.videoCodec || '').toLowerCase()
  if (!video) return 'remux'
  const browserNativeVideo = [
    'avc',
    'h264',
    'vp8',
    'vp9',
    'av1',
    'hevc',
    'h265',
  ]
  if (!browserNativeVideo.includes(video)) return 'transcode'
  // HEVC：只有 Safari/iOS 系能原生解，其他浏览器需要重编码
  if ((video === 'hevc' || video === 'h265') && !browserSupportsHevc()) {
    return 'transcode'
  }
  return 'remux'
}

let hevcSupport: boolean | null = null
function browserSupportsHevc(): boolean {
  if (hevcSupport !== null) return hevcSupport
  try {
    const probe = document.createElement('video')
    hevcSupport =
      probe.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '' ||
      probe.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== ''
  } catch {
    hevcSupport = false
  }
  return hevcSupport
}

/** 发起（或复用）一次服务端转码会话，返回带鉴权的 HLS 播放列表地址 */
export async function createTranscodeSession(opts: {
  movieId: number
  mode: 'remux' | 'transcode'
  start?: number
}): Promise<{ sessionId: string; playlistUrl: string }> {
  const res = await apiFetch('/api/transcode/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
  const data = (await res.json()) as {
    success: boolean
    sessionId?: string
    playlistUrl?: string
    message?: string
  }
  if (!res.ok || !data.success || !data.playlistUrl) {
    throw new Error(data.message || '服务端转码会话创建失败')
  }
  return { sessionId: data.sessionId ?? '', playlistUrl: data.playlistUrl }
}

/**
 * 设备不具备浏览器端转码能力时的完整说明文案。
 *
 * 服务端转码已改为房主控制，因此这里的指引是「请房主切到服务端」，
 * 而不是让观众自己去开（观众没有这个开关）。
 */
export function buildDeviceUnsupportedMessage(): string {
  const capability = cachedCapability
  const serverHint =
    capability && !capability.available
      ? '服务端未安装 ffmpeg，无法使用服务端转码（安装 ffmpeg 或设置 FFMPEG_PATH 后重试）'
      : '可请房主在播放列表把「转码方式」切到「服务端」后重试'
  return (
    `${describePlaysVideoSupport()}，本片源需要重封装或音频转码才能播放。` +
    `${serverHint}；也可改用 MP4（H.264 + AAC）片源，或用 Chrome / Edge 观看。`
  )
}
