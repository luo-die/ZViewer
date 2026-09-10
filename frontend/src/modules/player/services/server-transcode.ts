/**
 * 服务端转码（server-side transcode）。
 *
 * 给「跑不了浏览器端转码」的客户端兜底：由后端 ffmpeg 把源重封装/转码为 HLS，
 * 前端继续用 hls.js 播放；**iPhone（含 iOS 17.1 以下）走 Safari 原生 HLS**，
 * 因此不需要 MediaSource 也能看 MKV / DTS 这类源。
 *
 * 三个使用场景：
 * 1. 设备没有 MSE/MMS（iPhone < 17.1、部分浏览器）→ 自动兜底；
 * 2. 用户在播放列表手动打开「服务端转码」开关 → 强制走服务端；
 * 3. 浏览器端管线失败（编码解不了）→ 由手动开关兜底。
 *
 * 偏好（本机、localStorage）语义与浏览器转码引擎一致：
 * - 'on' ：强制服务端转码（即使浏览器自己也能播）
 * - 'off'：禁用服务端转码（只走浏览器端/原生）
 * - null ：自动（仅在必要时启用）
 */
import { useSyncExternalStore } from 'react'
import { apiFetch } from '@/lib/api'
import {
  describePlaysVideoSupport,
  isPlaysVideoSupported,
} from '@/modules/player/engines/playsvideo-engine'
import type { PlayerSource } from '@/modules/player/types'

export type ServerTranscodeOverride = 'on' | 'off' | null

const STORAGE_KEY = 'zviewer-server-transcode-override'
const CHANGE_EVENT = 'zviewer-server-transcode-override-change'

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

function readOverride(): ServerTranscodeOverride {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'on' || raw === 'off') return raw
  } catch {
    /* 隐私模式读不到 localStorage：按未设置处理 */
  }
  return null
}

let cachedOverride: ServerTranscodeOverride = readOverride()

export function getServerTranscodeOverride(): ServerTranscodeOverride {
  return cachedOverride
}

export function setServerTranscodeOverride(
  value: ServerTranscodeOverride
): void {
  cachedOverride = value
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* 写入失败时保留内存值，本次会话有效 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

const getSnapshot = (): ServerTranscodeOverride => cachedOverride

/** 订阅本机「服务端转码」偏好（播放列表开关用） */
export function useServerTranscodeOverride(): ServerTranscodeOverride {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 该源是否到了「浏览器端已经无能为力」的地步。
 *
 * mkv / avi / ts / wmv 容器，以及 DTS/AC3/EAC3/TrueHD 等浏览器不兼容音轨，
 * 都只能靠重封装或音频转码——此时如果没有 MSE/MMS，就必须上服务端。
 */
function needsRemuxOrTranscode(source: PlayerSource): boolean {
  const format = source.format
  if (format === 'avi' || format === 'ts' || format === 'wmv') return true
  if (format === 'mkv') return true
  const audio = (source.audioCodec || '').toLowerCase()
  if (audio && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(audio)) {
    return true
  }
  const video = (source.videoCodec || '').toLowerCase()
  if (video && !['avc', 'h264', 'vp8', 'vp9', 'av1'].includes(video)) {
    // HEVC 等：桌面 Chrome 解不了，服务端转码更稳
    return true
  }
  return false
}

/**
 * 是否需要走服务端转码（同步判定；调用方需自行确认能力已探测为可用）。
 *
 * 自动模式（override 为 null）只在「设备没有 MSE/MMS 且本源必须重封装/转码」时启用；
 * 显式 'on' 时无条件启用（用户自己选的，即使浏览器也能播）。
 */
export function shouldUseServerTranscode(source: PlayerSource): boolean {
  const override = cachedOverride
  if (override === 'off') return false
  if (cachedCapability && !cachedCapability.available) return false
  if (override === 'on') return true
  if (isPlaysVideoSupported()) return false
  return needsRemuxOrTranscode(source)
}

/** 服务端转码模式：浏览器解不了视频编码时需要重编码，否则只需重封装 */
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
 * 自动兜底不可用时的说明文案（用于播放失败提示）。
 */
export function describeServerTranscodeUnavailable(): string {
  const capability = cachedCapability
  if (!capability) return '正在探测服务端转码能力，请稍后重试'
  if (!capability.available) {
    return '服务端未安装 ffmpeg，无法使用服务端转码（安装 ffmpeg 或设置 FFMPEG_PATH 后重试）'
  }
  return '服务端转码不可用'
}

/** 设备能力缺失 + 服务端也不可用时的完整说明（供提示文案使用） */
export function buildDeviceUnsupportedMessage(): string {
  return (
    `${describePlaysVideoSupport()}，本片源需要重封装或音频转码才能播放。` +
    `${describeServerTranscodeUnavailable()}；` +
    '也可改用 MP4（H.264 + AAC）片源，或用 Chrome / Edge 观看。'
  )
}
