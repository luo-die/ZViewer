import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { apiFetch } from '@/lib/api'
import {
  detectFormat,
  parseSubtitle,
  getSubtitleLabel,
  type SubtitleFormat,
  type ParsedCue,
} from '@/lib/subtitleParser'
import { buildServerFileProxyUrl } from '@/modules/server-files/serverFilesApi'
import {
  probeMkvSubtitleTracks,
  streamMkvSubtitleTrack,
} from '@/modules/subtitles/mkv-embedded'
import { appendAuthToken } from '@/modules/player/services/url-proxy'
// 浏览器直连射手网（assrt）的兜底通道：服务器出网受限时使用
import {
  searchAssrtDirect,
  listAssrtFilesDirect,
  fetchAssrtFileText,
  buildSearchKeyword,
  extractEpisodeNumber,
  extractSeasonNumber,
  titleSimilarity,
  pickFileForEpisode,
  rankAssrtCandidates,
} from '@/modules/subtitles/assrt-direct'

export interface SubtitleTrack {
  cues: ParsedCue[]
  label: string
  lang?: string
}

/** 服务器文件内嵌字幕轨道（含用于展示的 label）。 */
export interface EmbeddedTrackInfo {
  index: number
  codecName: string
  language: string | null
  title: string | null
  label: string
  /** MKV TrackNumber（前端 demux 提取路径的轨道标识；Emby/Jellyfin 轨道无此字段） */
  trackNumber?: number
  /** 前端 MKV demux 提取的轨道为 true；Emby/Jellyfin 轨道为 false */
  frontend?: boolean
  /** Emby/Jellyfin：默认轨（自动挑选时优先） */
  isDefault?: boolean
  /** Emby/Jellyfin：强制轨（仅外语/歌曲字幕，自动挑选时靠后） */
  isForced?: boolean
  /**
   * Emby/Jellyfin：是否为文本字幕。false = 位图字幕（PGS/VOBSUB），
   * 无法转文本；undefined = 服务端未返回，按 codecName 兜底判断。
   */
  isText?: boolean
  /** Emby/Jellyfin：外挂字幕文件（与视频同目录） */
  isExternal?: boolean
  /**
   * 来自「原生 API」的字幕资源（第三方 Emby 兼容服务，如 uhdnow 系）：
   * 提取时后端会改用原生接口下载字幕文件，而不是 Emby 兼容层的字幕端点。
   */
  native?: boolean
  /**
   * 由「服务端 MKV 解容器」得到的轨道（index = MKV TrackNumber）：
   * 提取时后端直接从原始容器里解出字幕，不依赖媒体服务器字幕端点。
   */
  mkv?: boolean
}

/**
 * 内嵌字幕提取的源描述。
 * - server-files：后端本地文件路径
 * - webdav / openlist：中转与直链均可——前端 MKV demux 是唯一提取路径，失败静默（无回退）
 * - emby / jellyfin：直接用其自带字幕接口（PlaybackInfo / Subtitles Stream），不受直链限制
 * url：可 fetch 的中转/代理/直链 URL（提供时优先走前端 MKV demux 提取）
 * directLink：直链模式标记——前端失败时不回退
 */
export type EmbeddedSource =
  | { kind: 'server-files'; path: string; url?: string }
  | { kind: 'webdav'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'openlist'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'emby'; movieId: number }
  | { kind: 'jellyfin'; movieId: number }

/** Emby/Jellyfin 字幕接口返回的格式 → subtitleParser 的 SubtitleFormat（'webvtt' → 'vtt'）。 */
function mapOutputFormat(format: string): SubtitleFormat {
  switch (format) {
    case 'ass':
      return 'ass'
    case 'webvtt':
      return 'vtt'
    case 'smi':
      return 'smi'
    case 'sub':
      return 'sub'
    default:
      return 'srt'
  }
}

/**
 * 位图字幕编码（PGS/VOBSUB/DVB 等）：内容为图像，无法转成文本字幕。
 * 自动挑选字幕轨时跳过——否则提取出来是一条空轨。
 */
const IMAGE_SUBTITLE_CODECS = new Set([
  'pgs',
  'pgssub',
  'hdmv_pgs',
  'hdmv_pgs_subtitle',
  'dvdsub',
  'dvd_subtitle',
  'vobsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
  's_graphical',
  's_image',
])

function isImageSubtitleCodec(codec: string | null | undefined): boolean {
  return !!codec && IMAGE_SUBTITLE_CODECS.has(codec.trim().toLowerCase())
}

/** 中文字幕特征：语言码（zh/chi/zho/chs/cht/cn 前缀）或标题中的中文关键词。 */
const CHINESE_LANG_RE = /^(zh|chi|zho|chs|cht|cn)/i
const CHINESE_TEXT_RE = /中文|简体|繁体|中字|国语|粤语|双语|字幕组/i

function isChineseTrack(track: EmbeddedTrackInfo): boolean {
  const lang = (track.language ?? '').trim()
  if (lang && (CHINESE_LANG_RE.test(lang) || CHINESE_TEXT_RE.test(lang))) {
    return true
  }
  return CHINESE_TEXT_RE.test(`${track.title ?? ''} ${track.label ?? ''}`)
}

/**
 * 从可用轨道中挑选自动加载的首选字幕：
 * 中文字幕 > 默认轨（非强制）> 非强制轨 > 第一条文本轨。
 * 位图字幕（PGS/VOBSUB）与 isText=false 的轨道直接排除；
 * 全部为位图字幕时返回 undefined（此时不建轨，交给用户手动选择）。
 */
function pickPreferredEmbeddedTrack(
  tracks: EmbeddedTrackInfo[]
): EmbeddedTrackInfo | undefined {
  const textTracks = tracks.filter(
    (t) => t.isText !== false && !isImageSubtitleCodec(t.codecName)
  )
  if (textTracks.length === 0) return undefined
  return (
    textTracks.find(isChineseTrack) ??
    textTracks.find((t) => t.isDefault && !t.isForced) ??
    textTracks.find((t) => !t.isForced) ??
    textTracks[0]
  )
}

/** 生成内封字幕轨道的展示标签。 */
function embeddedTrackLabel(track: {
  title?: string | null
  language?: string | null
  index: number
}): string {
  return track.title || track.language || `轨道 ${track.index}`
}

export interface SubtitleState {
  subtitleEnabled: boolean
  subtitleTracks: SubtitleTrack[]
  activeTrackIndex: number
  /**
   * 当前字幕轨所属影片 id。
   * 切影片时旧影片的后台提取可能才刚完成——不带影片标记就会出现
   * 「播的是第二部、字幕却是第一部」的串台，因此广播与本地状态都带上它。
   */
  subtitleMovieId: number | null
  /** 副字幕轨索引（双语字幕）：-1 表示关闭 */
  secondaryTrackIndex: number
  subtitleFontSize: number
  /** 字幕时间偏移（秒），正值延迟显示，负值提前显示 */
  subtitleOffset: number
  /** 字幕水平位移（百分比，-50~50），正值右移 */
  subtitleShiftX: number
  /** 字幕垂直位移（百分比，-50~50），正值下移 */
  subtitleShiftY: number
  /** 字幕描边宽度（px，0~4），0 表示无描边 */
  subtitleStrokeWidth: number
  /** 字幕阴影模糊半径（px，0~12），0 表示无阴影 */
  subtitleShadowBlur: number
  /** 字幕字体族（CSS font-family），空串表示默认 */
  subtitleFontFamily: string
}

interface SubtitleBroadcastPayload {
  enabled: boolean
  tracks: SubtitleTrack[]
  activeIndex: number
  /** 这批字幕轨属于哪部影片（观众端据此丢弃串台的旧影片字幕） */
  movieId?: number | null
  /** 副字幕轨索引（双语），-1 关闭 */
  secondaryIndex?: number
  fontSize: number
  offset: number
  shiftX?: number
  shiftY?: number
  strokeWidth?: number
  shadowBlur?: number
  fontFamily?: string
}

export interface UseSubtitlesOptions {
  roomId: string
  isHost: boolean
  /** 当前播放的影片 id（用于丢弃切换影片后才返回的旧影片字幕） */
  currentMovieId?: number | null
}

const DEFAULT_SUBTITLE_STATE: SubtitleState = {
  subtitleEnabled: false,
  subtitleTracks: [],
  activeTrackIndex: -1,
  subtitleMovieId: null,
  secondaryTrackIndex: -1,
  subtitleFontSize: 20,
  subtitleOffset: 0,
  subtitleShiftX: 0,
  subtitleShiftY: 0,
  subtitleStrokeWidth: 0,
  subtitleShadowBlur: 4,
  subtitleFontFamily: '',
}

/**
 * 字幕样式（字号/位置/描边/阴影/字体）是「个人偏好」：每个浏览器各自记住，
 * 刷新/换影片/重新进房都保持不变；观众本地改过之后，房主广播不再覆盖它。
 */
const SUBTITLE_STYLE_KEY = 'zviewer-subtitle-style'

const DEFAULT_SUBTITLE_STYLE = {
  subtitleFontSize: 20,
  subtitleOffset: 0,
  subtitleShiftX: 0,
  subtitleShiftY: 0,
  subtitleStrokeWidth: 0,
  subtitleShadowBlur: 4,
  subtitleFontFamily: '',
} satisfies Partial<SubtitleState>

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

/** 读取本地保存的字幕样式（越界/损坏一律忽略，回退默认值） */
function readStoredSubtitleStyle(): Partial<SubtitleState> | null {
  try {
    const raw = localStorage.getItem(SUBTITLE_STYLE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const out: Partial<SubtitleState> = {}
    const fontSize = clampNumber(parsed.fontSize, 12, 50)
    if (fontSize !== undefined) out.subtitleFontSize = fontSize
    const offset = clampNumber(parsed.offset, -5, 5)
    if (offset !== undefined) out.subtitleOffset = offset
    const shiftX = clampNumber(parsed.shiftX, -50, 50)
    if (shiftX !== undefined) out.subtitleShiftX = shiftX
    const shiftY = clampNumber(parsed.shiftY, -50, 50)
    if (shiftY !== undefined) out.subtitleShiftY = shiftY
    const strokeWidth = clampNumber(parsed.strokeWidth, 0, 4)
    if (strokeWidth !== undefined) out.subtitleStrokeWidth = strokeWidth
    const shadowBlur = clampNumber(parsed.shadowBlur, 0, 12)
    if (shadowBlur !== undefined) out.subtitleShadowBlur = shadowBlur
    if (typeof parsed.fontFamily === 'string') out.subtitleFontFamily = parsed.fontFamily
    return out
  } catch {
    return null
  }
}

function saveStoredSubtitleStyle(state: SubtitleState): void {
  try {
    localStorage.setItem(
      SUBTITLE_STYLE_KEY,
      JSON.stringify({
        fontSize: state.subtitleFontSize,
        offset: state.subtitleOffset,
        shiftX: state.subtitleShiftX,
        shiftY: state.subtitleShiftY,
        strokeWidth: state.subtitleStrokeWidth,
        shadowBlur: state.subtitleShadowBlur,
        fontFamily: state.subtitleFontFamily,
      })
    )
  } catch {
    /* 隐私模式 / 配额不足：忽略，样式仍在本会话内生效 */
  }
}

/**
 * 字幕状态管理 + socket 同步。
 *
 * - 房主：调用 set* 方法变更状态并广播 `subtitle-update`
 * - 观众：监听 `subtitle-update` 自动应用相同配置
 *
 * 所有格式（SRT/ASS/SSA/VTT/SMI/SUB）解析为 ParsedCue[]，
 * 保留各格式的位置/对齐/样式信息，由自定义渲染层直接显示。
 * ParsedCue[] 是纯数据，可通过 socket 直接 JSON 序列化同步给观众。
 */
export function useSubtitles({
  roomId,
  isHost,
  currentMovieId,
}: UseSubtitlesOptions) {
  const { socket } = useSocket()
  // 本地保存过的样式只读一次：既用于初始状态，也决定观众是否算「已自定义」
  const storedStyleRef = useRef<Partial<SubtitleState> | null | undefined>(undefined)
  if (storedStyleRef.current === undefined) {
    storedStyleRef.current = readStoredSubtitleStyle()
  }
  const [state, setState] = useState<SubtitleState>(() => ({
    ...DEFAULT_SUBTITLE_STATE,
    ...(storedStyleRef.current ?? {}),
  }))

  // 观众本地偏好标记：观众自行修改过字幕设置（开关/轨道/字号/偏移）后，
  // 房主广播的 subtitle-update 只更新轨道数据，不再覆盖观众的本地选择。
  // 本地存过样式（说明观众之前就调过）同样视为已自定义。
  const viewerPrefTouchedRef = useRef(Boolean(storedStyleRef.current))
  /** 当前影片 id 镜像：异步提取回来时用它判断是否已经切片 */
  const currentMovieIdRef = useRef<number | null>(currentMovieId ?? null)
  useEffect(() => {
    currentMovieIdRef.current = currentMovieId ?? null
  }, [currentMovieId])
  /** 最新字幕状态镜像：延迟任务/回调读取，避免闭包陈旧 */
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  /**
   * 内嵌字幕提取世代 + 取消：切影片/清空轨道时使进行中的提取流立即
   * 失效（abort 网络拉流 + epoch 丢弃 in-flight chunk），防止旧影片
   * 的流式提取继续 append 污染新影片的字幕轨道。
   */
  const embeddedEpochRef = useRef(0)
  const embeddedAbortRef = useRef<AbortController | null>(null)
  /**
   * 内嵌字幕自动加载防重入标记：
   * StrictMode 双执行 / sourceUrl·开关异步初始化会重跑加载 effect，
   * 首次加载还在 await 探测时二次调用会与首路并行、重复建轨
   * （如 2 条字幕轨变成 4 条）。相同 URL 的 loading/done 均直接跳过；
   * clearTracks 只重置 done（loading 流无法取消，保留标记防并行）。
   */
  const embeddedAutoLoadRef = useRef<{
    url: string
    status: 'loading' | 'done'
  } | null>(null)

  const broadcast = useCallback(
    (next: SubtitleState) => {
      if (!socket || !isHost) return
      const payload: SubtitleBroadcastPayload = {
        enabled: next.subtitleEnabled,
        tracks: next.subtitleTracks,
        activeIndex: next.activeTrackIndex,
        movieId: next.subtitleMovieId,
        secondaryIndex: next.secondaryTrackIndex,
        fontSize: next.subtitleFontSize,
        offset: next.subtitleOffset,
        shiftX: next.subtitleShiftX,
        shiftY: next.subtitleShiftY,
        strokeWidth: next.subtitleStrokeWidth,
        shadowBlur: next.subtitleShadowBlur,
        fontFamily: next.subtitleFontFamily,
      }
      socket.emit('subtitle-update', { roomId, ...payload })
    },
    [socket, roomId, isHost]
  )

  const setEnabled = useCallback(
    (enabled: boolean) => {
      // 观众本地切换开关：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleEnabled: enabled,
          activeTrackIndex:
            enabled &&
            prev.activeTrackIndex < 0 &&
            prev.subtitleTracks.length > 0
              ? 0
              : prev.activeTrackIndex,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const setActiveTrack = useCallback(
    (index: number) => {
      // 观众本地切换轨道：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          activeTrackIndex: index,
          // 主字幕换成副字幕那条时关闭副字幕，避免同一轨渲染两遍
          secondaryTrackIndex:
            prev.secondaryTrackIndex === index ? -1 : prev.secondaryTrackIndex,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  /**
   * 设置副字幕轨（双语显示）：-1 关闭。
   * 与主字幕轨相同时自动关闭（同一轨重复渲染没有意义）。
   */
  const setSecondaryTrack = useCallback(
    (index: number) => {
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          secondaryTrackIndex:
            index >= 0 && index === prev.activeTrackIndex ? -1 : index,
          // 双语显示需要字幕渲染层处于开启状态
          subtitleEnabled: index >= 0 ? true : prev.subtitleEnabled,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  /**
   * 解析字幕内容并添加为轨道。
   *
   * 内部使用：将原始文本按格式解析为 ParsedCue[]，直接存入轨道。
   */
  const addParsedTrack = useCallback(
    (
      content: string,
      filename: string,
      format: SubtitleFormat,
      customLabel?: string,
      lang?: string
    ) => {
      const cues = parseSubtitle(content, format)
      const label = customLabel?.trim() || getSubtitleLabel(filename)

      setState((prev) => {
        const track: SubtitleTrack = {
          cues,
          label: label || `字幕 ${prev.subtitleTracks.length + 1}`,
          lang: lang?.trim() || undefined,
        }
        const next: SubtitleState = {
          ...prev,
          subtitleTracks: [...prev.subtitleTracks, track],
          subtitleEnabled: true,
          activeTrackIndex: prev.subtitleTracks.length,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const addTrackFromUrl = useCallback(
    async (url: string, label?: string, lang?: string) => {
      const trimmedUrl = url.trim()
      if (!trimmedUrl) return

      // fetch 内容后综合文件名+内容检测格式
      try {
        const res = await fetch(trimmedUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const content = await res.text()
        const detected = detectFormat(trimmedUrl, content)
        const filename =
          trimmedUrl.split('/').pop()?.split('?')[0] || 'subtitle'
        addParsedTrack(content, filename, detected, label, lang)
      } catch (err) {
        console.error('[useSubtitles] fetch subtitle URL failed:', err)
        // fetch 失败时添加空轨道
        setState((prev) => {
          const track: SubtitleTrack = {
            cues: [],
            label: label?.trim() || `字幕 ${prev.subtitleTracks.length + 1}`,
            lang: lang?.trim() || undefined,
          }
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: [...prev.subtitleTracks, track],
            subtitleEnabled: true,
            activeTrackIndex: prev.subtitleTracks.length,
          }
          broadcast(next)
          return next
        })
      }
    },
    [broadcast, addParsedTrack]
  )

  const addTrackFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result
        if (typeof content !== 'string') return
        const format = detectFormat(file.name, content)
        addParsedTrack(content, file.name, format)
      }
      reader.onerror = () => {
        console.error('[useSubtitles] read file error:', reader.error)
      }
      reader.readAsText(file)
    },
    [addParsedTrack]
  )

  /**
   * 从字幕内容直接添加轨道（供目录浏览器使用）。
   */
  const addTrackFromContent = useCallback(
    (content: string, filename: string, format: string) => {
      const fmt = format.toLowerCase() as SubtitleFormat
      addParsedTrack(content, filename, fmt)
    },
    [addParsedTrack]
  )

  const clearTracks = useCallback(() => {
    // 使进行中的内嵌提取流失效：abort 网络拉流 + 世代递增丢弃
    // in-flight chunk，防止旧影片的流继续 append 污染新轨道列表
    embeddedEpochRef.current++
    embeddedAbortRef.current?.abort()
    embeddedAbortRef.current = null
    // 清理自动加载的 URL 标记：done（已加载完）允许下次重新加载；
    // loading（进行中）保留——正在加载的流已被 abort，标记防并行重入
    if (embeddedAutoLoadRef.current?.status === 'done') {
      embeddedAutoLoadRef.current = null
    }
    setState((prev) => {
      const next: SubtitleState = {
        ...prev,
        subtitleTracks: [],
        subtitleEnabled: false,
        activeTrackIndex: -1,
        subtitleOffset: 0,
        subtitleMovieId: null,
        secondaryTrackIndex: -1,
      }
      broadcast(next)
      return next
    })
  }, [broadcast])

  /**
   * 自动搜索影片同目录下的字幕文件并加载。
   */
  const searchAutoSubtitles = useCallback(
    async (movieId: number): Promise<number> => {
      if (!isHost) return 0
      try {
        const res = await apiFetch(`/api/subtitles/search?movieId=${movieId}`)
        const data = (await res.json()) as {
          success: boolean
          subtitles?: { filename: string; format: string; content: string }[]
          message?: string
        }
        if (!res.ok || !data.success || !data.subtitles) {
          return 0
        }

        const found = data.subtitles
        if (found.length === 0) return 0

        // 解析所有字幕并构建轨道列表
        const newTracks: SubtitleTrack[] = found.map((sub) => {
          const format = sub.format as SubtitleFormat
          const cues = parseSubtitle(sub.content, format)
          const label = getSubtitleLabel(sub.filename) || sub.filename
          return { cues, label, lang: undefined }
        })

        // 一次性更新状态（清空旧轨道 + 加载新轨道）
        setState((prev) => {
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: newTracks,
            subtitleEnabled: true,
            activeTrackIndex: 0,
          }
          broadcast(next)
          return next
        })
        return found.length
      } catch (err) {
        console.error('[useSubtitles] auto search failed:', err)
        return 0
      }
    },
    [isHost, broadcast]
  )

  /**
   * 前端流式提取 MKV 字幕轨：首段到达即建轨生效（秒级可播），
   * 后台逐批补齐 cues，无需等完整提取。
   *
   * - 首段到达 → resolve（字幕已开始播放）
   * - 首段前失败 / 轨为空 → reject（调用方走回退）
   * - 首段后中断 → 已提取部分保留，仅记录错误
   * - 提取过程不广播（cues 逐批增长，全量广播代价随进度二次增长），
   *   完成后广播一次全量同步观众
   *
   * @param activate 建轨时是否激活为当前字幕轨
   */
  const streamEmbeddedTrack = useCallback(
    (
      url: string,
      track: { trackNumber: number; label: string; language: string | null },
      activate: boolean,
      getPriorityTime?: () => number | null,
      signal?: AbortSignal
    ): Promise<void> => {
      // 捕获提取世代：clearTracks/切影片递增后，本流的所有 chunk 丢弃
      const epoch = embeddedEpochRef.current
      return new Promise<void>((resolve, reject) => {
        let trackIndex = -1
        let settled = false
        let broadcastDone = false
        streamMkvSubtitleTrack(url, track.trackNumber, {
          getPriorityTime,
          signal,
          onChunk: (chunk) => {
            if (embeddedEpochRef.current !== epoch) return
            const cues = parseSubtitle(chunk.text, chunk.format)
            if (cues.length === 0) return
            setState((prev) => {
              if (trackIndex < 0) {
                // 去重：相同 label 的轨道已存在（手动重复提取 / 并行流）
                // 时复用它，避免重复建轨（如 2 条字幕轨变 4 条）
                const existing = prev.subtitleTracks.findIndex(
                  (t) => t.label === track.label
                )
                if (existing >= 0) {
                  trackIndex = existing
                  // 时间戳去重：观众本地提取与房主广播全量数据并存时，
                  // 同一轨的 cue（start 相同）只保留一份，避免重复字幕
                  const starts = new Set(
                    prev.subtitleTracks[existing]!.cues.map((c) => c.start)
                  )
                  const deduped = cues.filter((c) => !starts.has(c.start))
                  if (deduped.length === 0) return prev
                  return {
                    ...prev,
                    subtitleTracks: prev.subtitleTracks.map((t, i) =>
                      i === existing
                        ? { ...t, cues: [...t.cues, ...deduped] }
                        : t
                    ),
                  }
                }
                trackIndex = prev.subtitleTracks.length
                const next: SubtitleState = {
                  ...prev,
                  subtitleTracks: [
                    ...prev.subtitleTracks,
                    {
                      cues,
                      label: track.label,
                      lang: track.language || undefined,
                    },
                  ],
                  subtitleEnabled: true,
                  activeTrackIndex: activate ? trackIndex : prev.activeTrackIndex,
                }
                return next
              }
              return {
                ...prev,
                subtitleTracks: prev.subtitleTracks.map((t, i) =>
                  i === trackIndex ? { ...t, cues: [...t.cues, ...cues] } : t
                ),
              }
            })
            if (!settled) {
              settled = true
              resolve()
            }
          },
        }).then(
          () => {
            if (!settled) {
              settled = true
              reject(new Error('字幕轨为空'))
              return
            }
            // 提取完成：广播全量同步观众（updater 返回原引用不触发渲染）
            setState((prev) => {
              if (!broadcastDone) {
                broadcastDone = true
                broadcast(prev)
              }
              return prev
            })
          },
          (err) => {
            if (!settled) {
              settled = true
              reject(err)
            } else {
              console.error(
                '[useSubtitles] 流式提取中断（保留已提取部分）：',
                err instanceof Error ? err.message : err
              )
              setState((prev) => {
                if (!broadcastDone) {
                  broadcastDone = true
                  broadcast(prev)
                }
                return prev
              })
            }
          }
        )
      })
    },
    [] // setState 稳定；broadcast 不在流式过程中使用（完成时快照）
  )

  /**
   * 加载视频文件中的内嵌字幕轨道。
   * @param filePath server-files 路径
   * @param sourceUrl 挂载源（webdav/openlist，中转或直链）播放 URL
   * 全部走前端 MKV demux 提取（后端 ffmpeg 已移除，无回退链路）
   */
  const loadEmbeddedSubtitles = useCallback(
    async (
      filePath: string,
      sourceUrl?: string,
      getPriorityTime?: () => number | null
    ): Promise<number> => {
      // 观众已从房主广播获得字幕轨道时无需本地提取（广播数据优先）；
      // 房主提取中（大文件耗时数分钟）或广播缺失时观众本地提取
      if (!isHost && stateRef.current.subtitleTracks.length > 0) return 0

      // mkv-embedded 的 fetch 无法携带 Authorization 头，
      // 本站 /api/ URL 必须附加 token query（与播放引擎 appendAuthToken 一致），
      // 否则 401 → 探测失败显示「未检测到内嵌字幕」。直链 URL 原样返回。
      const url = appendAuthToken(sourceUrl ?? buildServerFileProxyUrl(filePath))

      // 防并行重入：同一 URL 加载中（首路还在探测）或已完成时，
      // StrictMode/effect 重跑的二次调用直接跳过，避免重复建轨
      if (embeddedAutoLoadRef.current?.url === url) return 0
      embeddedAutoLoadRef.current = { url, status: 'loading' }

      // 上一次提取流若还在跑（另一影片/URL），先取消防污染
      embeddedAbortRef.current?.abort()
      const controller = new AbortController()
      embeddedAbortRef.current = controller

      const finish = (started: number): number => {
        embeddedAutoLoadRef.current = { url, status: 'done' }
        return started
      }

      try {
        const probed = await probeMkvSubtitleTracks(
          url,
          undefined,
          controller.signal
        )
        const extractable = probed.filter((t) => t.supported)
        let started = 0
        for (const track of extractable) {
          try {
            // 逐轨 await 首段（秒级），后台继续补齐后续 cues
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              started === 0, // 首条成功轨激活；后续轨保持当前激活不变
              getPriorityTime,
              controller.signal
            )
            started++
          } catch (err) {
            if (controller.signal.aborted) return 0
            console.error(
              '[useSubtitles] frontend stream embedded subtitle failed:',
              track.trackNumber,
              err
            )
          }
        }
        if (started > 0) {
          // 首段已到达、字幕轨已生效，后台继续补齐，无需等待
          return finish(started)
        }
        // 一条都没提出来（如非 MKV 容器 / 全部为位图字幕轨）
        console.info(
          '[useSubtitles] 前端提取内嵌字幕不可用（非 MKV / 位图字幕轨 / CORS 拒绝），跳过自动加载'
        )
        return finish(0)
      } catch (err) {
        if (controller.signal.aborted) return 0
        console.info(
          '[useSubtitles] 前端探测内嵌字幕失败，跳过（无后端回退）：',
          err instanceof Error ? err.message : err
        )
        embeddedAutoLoadRef.current = null
        return 0
      }
    },
    [isHost, streamEmbeddedTrack]
  )

  /**
   * 列出视频文件内的内嵌字幕轨道（仅探测，不提取内容）。
   * 供 UI 先展示可用轨道，再由用户挑选某一条提取播放。
   * - server-files / webdav / openlist：前端 MKV demux 探测（唯一路径，无后端回退）
   * - emby / jellyfin：后端调用其自带 PlaybackInfo 接口
   */
  const listEmbeddedTracks = useCallback(
    async (source: EmbeddedSource): Promise<EmbeddedTrackInfo[]> => {
      if (!isHost) return []
      // 前端探测：server-files 恒有代理 URL；挂载源（中转/直链）带 URL 时同样可探测。
      // /api/ URL 需附加 token query（同播放引擎），否则 401 探测失败
      if (source.kind !== 'emby' && source.kind !== 'jellyfin') {
        const url = appendAuthToken(
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.url
        )
        if (url) {
          try {
            const probed = await probeMkvSubtitleTracks(url)
            return probed.map((t, i) => ({
              index: i,
              codecName: t.codecId,
              language: t.language,
              title: t.title,
              label: t.label,
              trackNumber: t.trackNumber,
              frontend: true,
            }))
          } catch (err) {
            // 唯一路径失败（常见原因：直链服务器未开 CORS、非 MKV 容器），无回退
            console.info(
              '[useSubtitles] 前端探测字幕轨失败（无后端回退）：',
              err instanceof Error ? err.message : err
            )
          }
        }
        return []
      }
      try {
        // Emby/Jellyfin：后端调用其 PlaybackInfo 接口
        const res = await apiFetch(
          `/api/subtitles/embedded-tracks?movieId=${source.movieId}`
        )
        const data = (await res.json()) as {
          success: boolean
          tracks?: EmbeddedTrackInfo[]
          message?: string
        }
        if (!res.ok || !data.success || !data.tracks) {
          throw new Error(data.message || '获取内嵌字幕轨道失败')
        }
        return data.tracks
      } catch (err) {
        console.error('[useSubtitles] list embedded tracks failed:', err)
        return []
      }
    },
    [isHost]
  )

  /**
   * 提取指定一条内嵌字幕轨道并添加为可播放的字幕轨道。
   * - server-files / webdav / openlist：前端 MKV demux 流式提取（track.frontend 标记，保留 ASS 样式）
   * - emby / jellyfin：后端调用其自带 Subtitles Stream 端点
   */
  const extractEmbeddedTrack = useCallback(
    async (
      source: EmbeddedSource,
      track: EmbeddedTrackInfo
    ): Promise<number> => {
      if (!isHost) return 0

      // 前端提取路径：探测阶段标记的 MKV 轨道
      if (track.frontend && track.trackNumber != null) {
        // /api/ URL 需附加 token query（同播放引擎），否则 401 提取失败
        const rawUrl =
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.kind === 'webdav' || source.kind === 'openlist'
              ? source.url
              : undefined
        const url = rawUrl ? appendAuthToken(rawUrl) : undefined
        if (url) {
          try {
            // 流式提取：首段到达即建轨生效（秒级可播），后台补齐
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              true
            )
            return 1
          } catch (err) {
            console.error(
              '[useSubtitles] frontend extract embedded track failed:',
              track.trackNumber,
              err
            )
            return 0 // 唯一路径失败，无后端回退
          }
        }
      }

      // Emby/Jellyfin：后端按轨道来源选择取字幕方式——
      // track.mkv=true → 服务端 MKV 解容器；track.native=true → 第三方服务原生 API；
      // 否则走 Emby 兼容层的 Subtitles Stream 端点
      if (source.kind !== 'emby' && source.kind !== 'jellyfin') return 0
      const sourceFlag = track.mkv ? '&mkv=1' : track.native ? '&native=1' : ''
      const extractUrl = `/api/subtitles/embedded-extract?movieId=${source.movieId}&index=${track.index}${sourceFlag}`
      try {
        // 服务端解容器要把整集文件顺序读一遍（首次约 1~2 分钟）：后端先返回
        // 202 pending 并转入后台提取，这里轮询等待。提取结果同时写入磁盘缓存，
        // 其他观看者与后续播放直接命中缓存，不再重复解容器。
        type ExtractPayload = {
          success: boolean
          pending?: boolean
          partial?: boolean
          content?: string
          format?: string
          label?: string
          language?: string | null
          message?: string
        }
        // 捕获提取世代：切影片（clearTracks）会递增，回来时若已切片就丢弃结果，
        // 否则会出现「播的是第二部、字幕却是第一部」的串台
        const epoch = embeddedEpochRef.current
        const trackLabel = track.label || embeddedTrackLabel(track)
        // 局部结果与最终结果共用同一套「建轨 / 更新轨」逻辑：
        // 已存在同 label 的轨道时用更多 cues 覆盖（渐进补齐），否则新建并激活
        const applyTrack = (
          content: string,
          format: string,
          label?: string,
          language?: string | null,
          allowBroadcast = true
        ): void => {
          const cues = parseSubtitle(content, mapOutputFormat(format || 'srt'))
          setState((prev) => {
            const finalLabel = trackLabel || label || embeddedTrackLabel(track)
            const existing = prev.subtitleTracks.findIndex(
              (t) => t.label === finalLabel
            )
            if (existing >= 0) {
              if (prev.subtitleTracks[existing]!.cues.length >= cues.length) {
                return prev // 无新增，避免无谓广播
              }
              const tracks = [...prev.subtitleTracks]
              tracks[existing] = {
                cues,
                label: finalLabel,
                lang: language ?? track.language ?? undefined,
              }
              const next: SubtitleState = {
                ...prev,
                subtitleTracks: tracks,
                subtitleMovieId: currentMovieIdRef.current,
              }
              if (allowBroadcast) broadcast(next)
              return next
            }
            const next: SubtitleState = {
              ...prev,
              subtitleTracks: [
                ...prev.subtitleTracks,
                {
                  cues,
                  label: finalLabel,
                  lang: language ?? track.language ?? undefined,
                },
              ],
              subtitleEnabled: true,
              activeTrackIndex: prev.subtitleTracks.length,
              subtitleMovieId: currentMovieIdRef.current,
            }
            if (allowBroadcast) broadcast(next)
            return next
          })
        }
        const deadline = Date.now() + 10 * 60 * 1000
        const startedAt = Date.now()
        // 观众端广播节流：部分结果每 20s 最多广播一次，完整结果立即广播
        let lastPartialBroadcast = 0
        const allowPartialBroadcast = (): boolean => {
          const now = Date.now()
          if (now - lastPartialBroadcast < 20_000) return false
          lastPartialBroadcast = now
          return true
        }
        let data: ExtractPayload | null = null
        for (;;) {
          if (embeddedEpochRef.current !== epoch) return 0
          const res = await apiFetch(extractUrl)
          data = (await res.json()) as ExtractPayload
          if (!data.pending) {
            if (!res.ok || !data.success || !data.content) {
              throw new Error(data.message || '提取内嵌字幕失败')
            }
            if (data.partial) {
              // 边提取边显示：先给已读到的部分，继续轮询补齐
              applyTrack(
                data.content,
                data.format || 'ass',
                data.label,
                data.language,
                allowPartialBroadcast()
              )
              console.info(
                `[useSubtitles] 字幕已部分可用（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s），后台继续补齐…`
              )
              await new Promise((resolve) => setTimeout(resolve, 4000))
              continue
            }
            break
          }
          if (Date.now() > deadline) {
            throw new Error(data.message || '字幕提取超时，请稍后重试')
          }
          console.info(
            `[useSubtitles] ${data.message || '字幕提取中…'}（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）`
          )
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
        if (!data || !data.content) {
          throw new Error('提取内嵌字幕失败')
        }
        if (embeddedEpochRef.current !== epoch) return 0
        applyTrack(
          data.content,
          data.format || 'srt',
          data.label,
          data.language,
          true
        )
        return 1
      } catch (err) {
        console.error(
          '[useSubtitles] extract embedded track failed:',
          track.index,
          err
        )
        // 抛出真实原因（后端会带回已尝试的字幕地址与状态），由调用方展示；
        // 自动加载路径（autoLoadEmbeddedTracks）内部已捕获，不受影响
        throw err
      }
    },
    [isHost, broadcast]
  )

  /**
   * 自动加载媒体服务器（Emby/Jellyfin）的字幕轨：
   * 探测轨道 → 挑选首选（中文 > 默认 > 非强制 > 首条文本轨）→ 提取内容建轨。
   *
   * 这是「播放 Emby 资源时没有字幕」的修复点：此前 emby/jellyfin 源只能由
   * 用户手动打开设置面板点「内嵌字幕轨道」再逐条提取，切换影片后永远默认无字幕。
   * Emby 的 MediaStreams 同时覆盖内嵌字幕与同目录外挂字幕（IsExternal），
   * 因此一条路径即可覆盖两种字幕来源。
   *
   * @returns 成功建轨数量（0 = 无可用文本字幕轨）
   */
  const autoLoadEmbeddedTracks = useCallback(
    async (source: EmbeddedSource): Promise<number> => {
      if (!isHost) return 0
      const epoch = embeddedEpochRef.current
      try {
        let tracks = await listEmbeddedTracks(source)
        if (embeddedEpochRef.current !== epoch) return 0
        if (tracks.length === 0) {
          // 探测失败与「确实没有字幕轨」返回值相同（上游限流 / 反代超时常见），
          // 稍等后重试一次再判定，避免误退到浏览器解容器（会打爆上游限流）
          await new Promise((resolve) => setTimeout(resolve, 3000))
          tracks = await listEmbeddedTracks(source)
        }
        const pick = pickPreferredEmbeddedTrack(tracks)
        if (!pick) return 0
        // 服务端解容器要把整集文件顺序读一遍（首次约 1~3 分钟），
        // 结果会落盘缓存，之后所有观看者与后续播放秒开
        console.info(
          '[useSubtitles] 正在服务端提取内嵌字幕（首次可能需要 1~3 分钟，之后走缓存）：',
          pick.label
        )
        return await extractEmbeddedTrack(source, pick)
      } catch (err) {
        console.error('[useSubtitles] auto load embedded tracks failed:', err)
        return 0
      }
    },
    [isHost, listEmbeddedTracks, extractEmbeddedTrack]
  )

  /**
   * 统一的样式修改入口：写本地存储（个人偏好，刷新/换影片都保留）+ 房主广播。
   * 观众改过之后标记偏好，后续房主广播不再覆盖其字号/位置等选择。
   */
  const applySubtitleStyle = useCallback(
    (patch: Partial<SubtitleState>) => {
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, ...patch }
        saveStoredSubtitleStyle(next)
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  // ==================== 在线字幕（射手网 assrt） ====================

  /** 按文件名推断字幕格式（浏览器直连路径用） */
  function formatFromAssrtName(name: string): 'ass' | 'srt' | 'vtt' {
    const lower = name.toLowerCase()
    if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass'
    if (lower.endsWith('.vtt')) return 'vtt'
    return 'srt'
  }

  /** 射手网 token 缓存：后端出网受限时，浏览器直连射手网需要它 */
  const assrtTokenRef = useRef<string | null>(null)
  const getAssrtToken = useCallback(async (): Promise<string> => {
    if (assrtTokenRef.current) return assrtTokenRef.current
    const res = await apiFetch('/api/subtitles/online/token')
    const data = (await res.json()) as {
      success: boolean
      token?: string
      message?: string
    }
    if (!res.ok || !data.success || !data.token) {
      throw new Error(data.message || '未配置射手网 API Token')
    }
    assrtTokenRef.current = data.token
    return data.token
  }, [])

  /**
   * 搜索在线字幕条目。
   * 先走后端（服务器可直接访问射手网时最省事）；后端返回 clientFallback
   * （服务器出网受限）时，改由浏览器直连射手网 API。
   */
  const searchOnlineSubtitles = useCallback(
    async (
      movieId: number,
      query?: string,
      fallbackTitle?: string
    ): Promise<{
      keyword: string
      candidates: {
        id: number
        title: string
        language?: string
        format?: string
        score?: number
        uploadTime?: string
      }[]
    }> => {
      const trimmed = query?.trim() ?? ""
      const q = trimmed ? "&q=" + encodeURIComponent(trimmed) : ""
      try {
        const res = await apiFetch(
          "/api/subtitles/online/search?movieId=" + movieId + q
        )
        const data = (await res.json()) as {
          success: boolean
          keyword?: string
          candidates?: {
            id: number
            title: string
            language?: string
            format?: string
            score?: number
            uploadTime?: string
          }[]
          message?: string
          clientFallback?: boolean
        }
        if (res.ok && data.success) {
          return { keyword: data.keyword ?? "", candidates: data.candidates ?? [] }
        }
        if (!data.clientFallback) {
          throw new Error(data.message || "在线字幕搜索失败")
        }
        console.info(
          "[useSubtitles] 服务器无法访问射手网，改用浏览器直连：",
          data.message
        )
      } catch (err) {
        if (!(err instanceof Error) || !/无法访问射手网|连接失败|请求超时|fetch failed/i.test(err.message)) {
          throw err
        }
      }
      // 浏览器直连兜底
      const keyword = trimmed || buildSearchKeyword(fallbackTitle ?? "")
      if (!keyword) throw new Error("无法确定搜索关键词")
      const token = await getAssrtToken()
      const candidates = await searchAssrtDirect(keyword, token)
      return { keyword, candidates }
    },
    [getAssrtToken]
  )

  /** 列出某条在线字幕的文件（后端优先，失败改浏览器直连） */
  const listOnlineSubtitleFiles = useCallback(
    async (
      id: number
    ): Promise<{ index: number; name: string; size?: string }[]> => {
      try {
        const res = await apiFetch("/api/subtitles/online/files?id=" + id)
        const data = (await res.json()) as {
          success: boolean
          files?: { index: number; name: string; size?: string }[]
          message?: string
          clientFallback?: boolean
        }
        if (res.ok && data.success) return data.files ?? []
        if (!data.clientFallback) {
          throw new Error(data.message || "获取字幕文件列表失败")
        }
      } catch (err) {
        if (!(err instanceof Error) || !/无法访问射手网|连接失败|请求超时|fetch failed/i.test(err.message)) {
          throw err
        }
      }
      const token = await getAssrtToken()
      const direct = await listAssrtFilesDirect(id, token)
      return direct.files
    },
    [getAssrtToken]
  )

  /** 下载在线字幕文件并加入轨道（后端优先，失败改浏览器直连） */
  const loadOnlineSubtitle = useCallback(
    async (id: number, index: number): Promise<number> => {
      if (!isHost) return 0
      try {
        const res = await apiFetch(
          "/api/subtitles/online/load?id=" + id + "&index=" + index
        )
        const data = (await res.json()) as {
          success: boolean
          content?: string
          format?: string
          label?: string
          language?: string | null
          message?: string
          clientFallback?: boolean
        }
        if (res.ok && data.success && data.content) {
          addParsedTrack(
            data.content,
            data.label || "在线字幕",
            mapOutputFormat(data.format || "srt"),
            data.label,
            data.language ?? undefined
          )
          return 1
        }
        if (!data.clientFallback) {
          throw new Error(data.message || "下载在线字幕失败")
        }
      } catch (err) {
        if (!(err instanceof Error) || !/无法访问射手网|连接失败|请求超时|fetch failed/i.test(err.message)) {
          throw err
        }
      }
      const token = await getAssrtToken()
      const direct = await listAssrtFilesDirect(id, token)
      const file = direct.files.find((f) => f.index === index)
      if (!file || !file.url) throw new Error("射手网未提供该字幕文件")
      const content = await fetchAssrtFileText(file.url)
      const label = file.name.replace(/\.[a-z0-9]+$/i, "")
      addParsedTrack(content, file.name, mapOutputFormat(formatFromAssrtName(file.name)), label)
      return 1
    },
    [addParsedTrack, getAssrtToken, isHost]
  )

  /**
   * 保底自动匹配：媒体服务器没有任何可用字幕时，按影片标题到射手网自动
   * 匹配并加载（季数/集数都会校验，相似度不足则不套用）。
   * 后端出网受限时改由浏览器直连。
   */
  const autoLoadOnlineSubtitle = useCallback(
    async (
      movieId: number,
      fallbackTitle?: string,
      fallbackPath?: string
    ): Promise<number> => {
      if (!isHost) return 0
      try {
        const res = await apiFetch(
          "/api/subtitles/online/auto?movieId=" + movieId
        )
        const data = (await res.json()) as {
          success: boolean
          content?: string
          format?: string
          label?: string
          language?: string | null
          message?: string
          clientFallback?: boolean
        }
        if (res.ok && data.success && data.content) {
          addParsedTrack(
            data.content,
            data.label || "在线字幕",
            mapOutputFormat(data.format || "srt"),
            data.label,
            data.language ?? undefined
          )
          console.info("[useSubtitles] 已自动套用在线字幕:", data.label)
          return 1
        }
        if (!data.clientFallback) {
          console.info(
            "[useSubtitles] 在线字幕自动匹配未命中:",
            data.message || res.status
          )
          return 0
        }
      } catch (err) {
        if (!(err instanceof Error) || !/无法访问射手网|连接失败|请求超时|fetch failed/i.test(err.message)) {
          console.info("[useSubtitles] 在线字幕自动匹配失败:", err)
          return 0
        }
      }
      // 浏览器直连兜底：搜索 → 排序 → 选集 → 下载
      try {
        const keyword = buildSearchKeyword(fallbackTitle ?? "", fallbackPath)
        if (!keyword) return 0
        const episode = extractEpisodeNumber(fallbackTitle ?? "", fallbackPath)
        const season = extractSeasonNumber(fallbackTitle ?? "", fallbackPath)
        const token = await getAssrtToken()
        const candidates = await searchAssrtDirect(keyword, token)
        if (candidates.length === 0) return 0
        const ranked = rankAssrtCandidates(keyword, candidates, season)
        const best = ranked[0]!
        const bestScore = Math.max(
          titleSimilarity(keyword, best.title),
          titleSimilarity(keyword, best.videoName ?? "")
        )
        if (bestScore < 0.35) {
          console.info("[useSubtitles] 在线字幕相似度不足，跳过自动套用")
          return 0
        }
        const direct = await listAssrtFilesDirect(best.id, token)
        const file = pickFileForEpisode(direct.files, episode)
        if (!file || !file.url) return 0
        const content = await fetchAssrtFileText(file.url)
        const label = file.name.replace(/\.[a-z0-9]+$/i, "")
        addParsedTrack(
          content,
          file.name,
          mapOutputFormat(formatFromAssrtName(file.name)),
          label,
          best.language
        )
        console.info("[useSubtitles] 已自动套用在线字幕（浏览器直连）:", label)
        return 1
      } catch (err) {
        console.info("[useSubtitles] 浏览器直连射手网失败:", err)
        return 0
      }
    },
    [addParsedTrack, getAssrtToken, isHost]
  )

  const setFontSize = useCallback(
    (size: number) => applySubtitleStyle({ subtitleFontSize: size }),
    [applySubtitleStyle]
  )

  const setOffset = useCallback(
    (offset: number) => applySubtitleStyle({ subtitleOffset: offset }),
    [applySubtitleStyle]
  )

  const setShiftX = useCallback(
    (shiftX: number) => applySubtitleStyle({ subtitleShiftX: shiftX }),
    [applySubtitleStyle]
  )

  const setShiftY = useCallback(
    (shiftY: number) => applySubtitleStyle({ subtitleShiftY: shiftY }),
    [applySubtitleStyle]
  )

  const setStrokeWidth = useCallback(
    (strokeWidth: number) => applySubtitleStyle({ subtitleStrokeWidth: strokeWidth }),
    [applySubtitleStyle]
  )

  const setShadowBlur = useCallback(
    (shadowBlur: number) => applySubtitleStyle({ subtitleShadowBlur: shadowBlur }),
    [applySubtitleStyle]
  )

  const setFontFamily = useCallback(
    (fontFamily: string) => applySubtitleStyle({ subtitleFontFamily: fontFamily }),
    [applySubtitleStyle]
  )

  /** 恢复默认字号/位置/描边/阴影/字体（仅样式，不动字幕轨） */
  const resetSubtitleStyle = useCallback(
    () => applySubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE }),
    [applySubtitleStyle]
  )

  // 观众：接收房主的字幕广播
  useEffect(() => {
    if (!socket || isHost) return
    const handler = (
      payload: Partial<SubtitleBroadcastPayload> | undefined
    ) => {
      if (!payload) return
      // 房主清空字幕（切影片）时，观众本地的内嵌提取流一并失效，
      // 防止旧影片的流继续 append 重建轨道
      if (Array.isArray(payload.tracks) && payload.tracks.length === 0) {
        embeddedEpochRef.current++
        embeddedAbortRef.current?.abort()
        embeddedAbortRef.current = null
      }
      // 串台保护：房主切影片后，旧影片的后台提取可能才刚返回并广播，
      // 此时观众端已在放新影片——不属于当前影片的轨道一律丢弃
      if (
        payload.movieId != null &&
        currentMovieIdRef.current != null &&
        payload.movieId !== currentMovieIdRef.current
      ) {
        return
      }
      // 观众改过本地偏好（开关/轨道/字号/偏移）后，房主广播只更新轨道
      // 数据；偏好字段保持观众本地选择。未改过则全量跟随房主。
      const touched = viewerPrefTouchedRef.current
      setState((prev) => ({
        subtitleEnabled: touched
          ? prev.subtitleEnabled
          : payload.enabled ?? prev.subtitleEnabled,
        // 轨道数据：以房主广播为基准（数量/顺序/新增/清空均跟随房主，
        // 房主手动上传的轨道由此同步给观众）；仅当本地同索引轨道 label
        // 一致且 cues 更多（观众本地流式提取进度领先房主快照）时保留
        // 本地该条——本地提取有 seek 感知（房主跳转后观众跟随跳转也能
        // 秒出字幕），且避免替换打断进行中的流
        subtitleTracks: payload.tracks
          ? payload.tracks.map((t, i) => {
              const local = prev.subtitleTracks[i]
              return local &&
                local.label === t.label &&
                local.cues.length > t.cues.length
                ? local
                : t
            })
          : prev.subtitleTracks,
        activeTrackIndex: touched
          ? prev.activeTrackIndex
          : payload.activeIndex ?? prev.activeTrackIndex,
        subtitleMovieId: payload.movieId ?? prev.subtitleMovieId,
        secondaryTrackIndex:
          payload.secondaryIndex ?? prev.secondaryTrackIndex,
        subtitleFontSize: touched
          ? prev.subtitleFontSize
          : payload.fontSize ?? prev.subtitleFontSize,
        subtitleOffset: touched
          ? prev.subtitleOffset
          : payload.offset ?? prev.subtitleOffset,
        subtitleShiftX: touched
          ? prev.subtitleShiftX
          : payload.shiftX ?? prev.subtitleShiftX,
        subtitleShiftY: touched
          ? prev.subtitleShiftY
          : payload.shiftY ?? prev.subtitleShiftY,
        subtitleStrokeWidth: touched
          ? prev.subtitleStrokeWidth
          : payload.strokeWidth ?? prev.subtitleStrokeWidth,
        subtitleShadowBlur: touched
          ? prev.subtitleShadowBlur
          : payload.shadowBlur ?? prev.subtitleShadowBlur,
        subtitleFontFamily: touched
          ? prev.subtitleFontFamily
          : payload.fontFamily ?? prev.subtitleFontFamily,
      }))
    }
    socket.on('subtitle-update', handler)
    // 加入时后端在 request-join 处理中回发的 subtitle-update 早于此
    // 监听器挂载（组件渲染后才有 useEffect），会丢失。挂载完成后主动
    // 拉取一次房主缓存的字幕状态，确保中途加入/刷新的观众也能拿到字幕。
    socket.emit('subtitle-request', { roomId })
    return () => {
      socket.off('subtitle-update', handler)
    }
  }, [socket, isHost, roomId])

  return {
    ...state,
    setEnabled,
    setActiveTrack,
    setSecondaryTrack,
    addTrackFromUrl,
    addTrackFromFile,
    addTrackFromContent,
    clearTracks,
    searchAutoSubtitles,
    loadEmbeddedSubtitles,
    listEmbeddedTracks,
    extractEmbeddedTrack,
    autoLoadEmbeddedTracks,
    setFontSize,
    setOffset,
    setShiftX,
    setShiftY,
    setStrokeWidth,
    setShadowBlur,
    setFontFamily,
    resetSubtitleStyle,
    searchOnlineSubtitles,
    listOnlineSubtitleFiles,
    loadOnlineSubtitle,
    autoLoadOnlineSubtitle,
  }
}
