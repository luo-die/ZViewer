/**
 * playsvideo 引擎：浏览器端容器重封装 + 音轨转码。
 *
 * 取代原 wasm-engine（自研 EBML demux + 31MB 全量 ffmpeg 核心 + 手写 MSE），
 * 采用 playsvideo 库的三段式管线：
 *
 * ```
 * 视频文件（MKV/MP4/AVI/TS/WebM）
 *   → mediabunny 流式 demux（任意文件大小，Range 随机读取）
 *   → 关键帧对齐的分段计划
 *   → 每段：视频直通重封装 / 音频按需转码（AC3/EAC3/DTS/FLAC/MP3/Opus → AAC）
 *   → fMP4 分段 + m3u8
 *   → hls.js 按需取段播放
 * ```
 *
 * 相对旧 wasm-engine 的关键改进：
 * - **MSE 交给 hls.js**：不再手写 timestampOffset / appendWindow / 需求门控，
 *   从根上消除 InvalidStateError 刷屏与 seek 跳越失败。
 * - **核心体积 31MB → 1.9MB**：仅编译音频编解码器的专用 ffmpeg 构建，
 *   且随前端构建产物分发（不再运行时从 CDN 下载）。
 * - **自动决策直通/重封装**：playsvideo 的 playback-selection 会评估
 *   direct-url / direct-bytes / hls 三条路径，能原生播就原生播。
 *
 * 两个必须绕开的限制：
 * 1. **不支持自定义请求头**：`loadUrl()` 内部由 mediabunny `UrlSource` 裸
 *    fetch 取流，无法携带防盗链 Referer/UA，也受 CORS 约束。因此跨域源
 *   一律走后端 `/api/stream/proxy`（同源、后端注入 headers、透传 Range）。
 * 2. **内嵌字幕由 playsvideo 提取，但由 ZViewer 渲染**：
 *    playsvideo 的产物是本机 `<track>` + blob URL，无法经 socket 广播给
 *    观众，因此 playsvideo-subtitle-bridge 会把它们取回并解析成
 *    ParsedCue[]，交回 ZViewer 既有的渲染与广播管线。
 *
 * 关于 `embeddedSubtitlePolicy: 'off'`：该策略**只关闭自动选中**，不阻止
 * 提取（见引擎源码——策略仅用于 shouldAutoSelectEmbeddedSubtitle）。保留
 * off 可让轨道挂上但不原生渲染，避免与 ZViewer 的 SubtitleOverlay 双字幕。
 *
 * 已知取舍：playsvideo 在导出 WebVTT 时会用 stripAssTags 剥掉 ASS 覆盖
 * 标签且丢弃样式表头，所以 ASS 特效在此链路下不可恢复地退化为纯文本。
 */
import { PlaysVideoEngine } from 'playsvideo'
import {
  fetchPlaysVideoTrackCues,
  publishPlaysVideoSubtitle,
  resetPlaysVideoSubtitles,
} from './playsvideo-subtitle-bridge'
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  PlayerController,
  SeekResult,
} from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import {
  buildProxyUrl,
  appendAuthToken,
  isLocalUrl,
  isRelativeUrl,
} from '../services/url-proxy'

/**
 * 引擎准备超时（毫秒）。
 *
 * 起播需完成探测 + 关键帧索引 + 首段产出，大文件或慢源可能耗时较久；
 * 超时后由 usePlayerSource 的回退链路降级为原生播放。
 */
const READY_TIMEOUT_MS = 60_000

/**
 * 浏览器端转码（playsvideo）的运行能力。
 *
 * 管线本身要求「能把 fMP4 分片喂给 <video>」，对应两种 API：
 * - `MediaSource`（MSE，桌面 Chrome/Edge/Firefox/桌面 Safari、iPadOS Safari）
 * - `ManagedMediaSource`（MMS，**iPhone Safari 17.1+ 才有**的托管版 MSE；
 *   它继承 MediaSource，静态 isTypeSupported 通用，hls.js 1.5+ 原生支持）
 *
 * iPhone 在 17.1 之前两者都没有 —— 此时浏览器端转码**在原理上就不可能**：
 * <video> 只接受完整文件（URL / Blob），没有「边转边喂」的通道。
 * 这不是引擎的 bug，而是平台能力缺失，需要给用户准确的提示而不是
 * 「开启浏览器转码引擎后重试」这种无效引导。
 */
export type PlaysVideoSupport =
  | { ok: true; kind: 'mse' | 'managed-mse' }
  | { ok: false; reason: 'no-worker' | 'no-mse' | 'no-codec' }

/** 单例探测结果（能力在整个会话内不变，重复探测无意义） */
let cachedSupport: PlaysVideoSupport | null = null

/**
 * 探测浏览器端转码能力（含原因，供文案与降级决策使用）。
 */
export function getPlaysVideoSupport(): PlaysVideoSupport {
  if (cachedSupport) return cachedSupport
  cachedSupport = detectPlaysVideoSupport()
  return cachedSupport
}

function detectPlaysVideoSupport(): PlaysVideoSupport {
  if (typeof window === 'undefined') return { ok: false, reason: 'no-mse' }
  if (typeof Worker !== 'function') return { ok: false, reason: 'no-worker' }

  const g = globalThis as unknown as {
    MediaSource?: { isTypeSupported?: (type: string) => boolean }
    ManagedMediaSource?: { isTypeSupported?: (type: string) => boolean }
  }
  const mse = g.MediaSource
  const mms = g.ManagedMediaSource
  const source = mse ?? mms
  if (!source || typeof source.isTypeSupported !== 'function') {
    return { ok: false, reason: 'no-mse' }
  }
  const codecOk = !!source.isTypeSupported(
    'video/mp4; codecs="avc1.640029, mp4a.40.2"'
  )
  if (!codecOk) return { ok: false, reason: 'no-codec' }
  return { ok: true, kind: mse ? 'mse' : 'managed-mse' }
}

/** 判断当前浏览器是否具备 playsvideo 引擎的运行条件（MSE/MMS + Worker） */
export function isPlaysVideoSupported(): boolean {
  return getPlaysVideoSupport().ok
}

/**
 * 能力缺失时的用户文案（用于播放失败提示）。
 *
 * iOS 的两种情况必须区分：
 * - iPhone < 17.1：平台没有 MSE/MMS，无解，只能换片源或换设备；
 * - 其他：浏览器缺少能力，建议换浏览器。
 */
export function describePlaysVideoSupport(): string {
  const support = getPlaysVideoSupport()
  // 注意：前端 tsconfig 未开 strict，布尔字面量判别式（if (support.ok)）
  // 不会触发布尔判别联合的收窄，必须用 === true 比较式收窄。
  if (support.ok === true) return '当前浏览器支持浏览器端转码'
  switch (support.reason) {
    case 'no-worker':
      return '当前浏览器不支持 Web Worker，无法运行浏览器端转码'
    case 'no-codec':
      return '当前浏览器不支持 fMP4（H.264/AAC）分片播放，无法运行浏览器端转码'
    default:
      return '当前浏览器不支持 MediaSource / ManagedMediaSource，无法运行浏览器端转码'
  }
}

/**
 * 解析 playsvideo 实际取流地址。
 *
 * 与 `resolveProxyUrl`（direct 引擎用，跨域优先直连省服务器流量）不同，
 * 本引擎**必须**保证同源：mediabunny 的裸 fetch 既带不了防盗链头，
 * 也过不了 CORS。故跨域源一律后端代理——代价是服务器承担流量，
 * 换来的是任意容器/编码都能播。
 */
function resolvePlaysVideoUrl(source: PlayerSource): string {
  const url = source.url
  if (!url) return url
  // 同源 / 相对路径（如 /api/webdav/stream、/api/server-files/raw）：
  // 直接请求，仅需补 token（HTTP 环境下无 auth cookie）。
  if (isLocalUrl(url) || isRelativeUrl(url)) return appendAuthToken(url)
  // 跨域：走后端代理，由后端注入防盗链头并透传 Range。
  return buildProxyUrl(url)
}

/**
 * playsvideo 播放控制器。
 *
 * 每次 attach 都创建全新引擎世代（内部持有 worker + hls.js 实例），
 * 与旧 WasmPlayerController 的世代模型一致：切换/重载时旧实例整体销毁，
 * 杜绝残留管线继续向已拆除的 SourceBuffer 写入。
 */
class PlaysVideoController implements PlayerController {
  private video: HTMLVideoElement
  private source: PlayerSource
  private engine: PlaysVideoEngine | null = null
  /** 世代计数：异步 attach 返回时据此判断是否已被新实例取代 */
  private generation = 0
  /** 字幕桥接世代：attach 时向桥接层申请，切影片后旧结果自动作废 */
  private subtitleGen = 0
  /** 已处理过的 <track> 元素，避免重复提取（addtrack 可能重发） */
  private handledTrackEls = new WeakSet<HTMLTrackElement>()
  /** 本会话已发布字幕轨数量，用于推算轨道序号 */
  private publishedSubtitleCount = 0
  /** 撤销 addtrack 监听（cleanup 时调用） */
  private unbindSubtitles: (() => void) | null = null
  /** 中断进行中的字幕 blob 读取 */
  private subtitleAbort: AbortController | null = null

  constructor(video: HTMLVideoElement, source: PlayerSource) {
    this.video = video
    this.source = source
  }

  get isAttached(): boolean {
    return !!this.engine && this.engine.phase === 'ready'
  }

  get isSeeking(): boolean {
    return false
  }

  async attach(startTime?: number): Promise<string> {
    if (!isPlaysVideoSupported()) {
      throw new Error(describePlaysVideoSupport())
    }

    // 结束旧世代（切换 / 重载场景）
    this.cleanup()
    resetVideoElement(this.video)

    const gen = ++this.generation
    const url = resolvePlaysVideoUrl(this.source)

    const engine = new PlaysVideoEngine(this.video, {
      // 提取内嵌字幕但**不自动选中**：轨道会挂到 video 上（blob URL），
      // 由 playsvideo-subtitle-bridge 取回转成 ParsedCue[] 交给 ZViewer
      // 渲染。若改为 'auto' 会同时启用原生渲染，与 SubtitleOverlay 重影。
      embeddedSubtitlePolicy: 'off',
    })
    this.engine = engine

    // 开启新字幕会话：旧会话迟到的提取结果会被桥接层丢弃
    this.subtitleGen = resetPlaysVideoSubtitles()
    this.bindSubtitleBridge()

    try {
      engine.loadUrl(url)
      await this.waitReady(engine)
    } catch (err) {
      // 起播失败（容器不支持 / 探测超时 / 取流不可达）：
      // 必须终结本世代并释放 worker，否则旧管线残留会与回退引擎竞争 video。
      if (this.engine === engine) {
        this.destroyEngine()
        this.generation++
      }
      throw err
    }

    // 世代已被取代：本次 attach 的结果作废，静默让位
    if (gen !== this.generation) {
      return ''
    }

    // 时长兜底：HLS 模式下 video.duration 由 hls.js 填充，
    // 少数源不可用时由控制栏回退读 dataset.serverDuration。
    if (engine.durationSec > 0) {
      this.video.dataset.serverDuration = String(engine.durationSec)
    }

    // pipeline 模式下 ready 先于 startHls 触发，此时 readyState 可能仍为 0，
    // 直接赋值 currentTime 会被浏览器丢弃（与 waitForMetadata 的注释同理）。
    await waitForMetadata(this.video)

    const start = startTime ?? this.source.startTime ?? 0
    if (start > 0) {
      try {
        this.video.currentTime = start
      } catch {
        // seek 失败不阻断 attach：停留在 0 由上层同步逻辑纠正
      }
    }

    // 无 blob URL：playsvideo 直接接管 video.src
    return ''
  }

  /**
   * 等待引擎 ready / error。
   *
   * 同时监听 error 事件与超时——只触发 error 不触发 ready 的失败若
   * 不 reject，Promise 永不 settle，会卡死 attach 串行队列（播放器假死）。
   *
   * 世代校验不在这里做：监听器注册时 gen 必然等于当前世代，判断无意义；
   * 真正的作废检查在 attach 的 await 之后进行。
   */
  private waitReady(engine: PlaysVideoEngine): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        engine.removeEventListener('ready', onReady)
        engine.removeEventListener('error', onError)
        clearTimeout(timer)
      }
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = (e: Event) => {
        cleanup()
        const detail = (e as CustomEvent<{ message?: string }>).detail
        reject(new Error(detail?.message || 'playsvideo 引擎启动失败'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('playsvideo 引擎准备超时（60s）'))
      }, READY_TIMEOUT_MS)

      engine.addEventListener('ready', onReady)
      engine.addEventListener('error', onError)
    })
  }

  /**
   * seek 到目标时间。
   *
   * playsvideo 的 HLS 管线由 hls.js 托管，直接设置 `video.currentTime`
   * 即可——hls.js 会自动加载目标位置所属分段，无需（也不能）手动
   * 清理 SourceBuffer 或重建 MediaSource。这正是取代手写 MSE 的最大收益。
   */
  async seekTo(targetTime: number): Promise<SeekResult> {
    if (!this.engine || this.engine.phase !== 'ready') {
      return { success: false, needReload: true, message: '未挂载' }
    }
    try {
      this.video.currentTime = targetTime
      return { success: true }
    } catch (err) {
      return {
        success: false,
        needReload: true,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * 监听 playsvideo 挂载的原生字幕轨，取回内容后交给 ZViewer 渲染管线。
   *
   * playsvideo 每提取完一条轨就 `video.appendChild(track)`，触发
   * `textTracks` 的 addtrack 事件。ZViewer 与 ArtPlayer 都不创建 `<track>`
   * 元素，因此挂到 video 上的必然是 playsvideo 的轨道。
   *
   * 提取是异步且滞后的（大文件可能晚于起播数十秒），故走事件而非轮询。
   */
  private bindSubtitleBridge(): void {
    const video = this.video
    const gen = this.subtitleGen

    // 用 MutationObserver 而非 video.textTracks 的 addtrack 事件：
    // addtrack 的触发时机依赖浏览器的 TextTrackList 实现细节（不同浏览器
    // 在 <track> 插入后何时把它纳入列表并不一致），一旦不触发就会静默丢失
    // 全部内嵌字幕。MutationObserver 监听的是 appendChild 这个 DOM 动作
    // 本身，语义确定，不受浏览器差异影响。
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLTrackElement) {
            void this.extractSubtitleTrack(node, gen)
          }
        }
      }
    })
    observer.observe(video, { childList: true })

    // 兜底：绑定前就已存在的轨道（引擎复用等场景）立即补扫一次
    for (const el of video.querySelectorAll('track')) {
      void this.extractSubtitleTrack(el, gen)
    }

    this.unbindSubtitles = () => observer.disconnect()
  }

  /** 取回单条轨道的 WebVTT 内容并发布给字幕桥接层。 */
  private async extractSubtitleTrack(
    element: HTMLTrackElement,
    gen: number
  ): Promise<void> {
    if (this.handledTrackEls.has(element)) return
    this.handledTrackEls.add(element)

    const abort = this.subtitleAbort ?? new AbortController()
    this.subtitleAbort = abort

    const label = element.label || '未命名轨道'
    const cues = await fetchPlaysVideoTrackCues(element, abort.signal)
    console.info(
      `[playsvideo-subtitles] 轨道「${label}」取回 ${cues.length} 条 cue`
    )
    if (cues.length === 0) return

    // 轨道序号按挂载顺序推算：playsvideo 依 subtitleTracks 顺序依次 append
    const ordinal = this.publishedSubtitleCount++
    const info = this.engine?.subtitleTracks?.[ordinal]

    publishPlaysVideoSubtitle(gen, {
      index: ordinal,
      label: element.label || `轨道 ${ordinal + 1}`,
      language: element.srclang || info?.language || null,
      codec: info?.codec ?? 'unknown',
      cues,
    })
    console.info(`[playsvideo-subtitles] 轨道「${label}」已发布（世代 ${gen}）`)
  }

  private destroyEngine(): void {
    try {
      this.engine?.destroy()
    } catch {
      /* ignore */
    }
    this.engine = null
  }

  cleanup(): void {
    // 先停字幕再毁引擎：避免 destroy 移除 <track> 时触发无意义的提取
    this.unbindSubtitles?.()
    this.unbindSubtitles = null
    this.subtitleAbort?.abort()
    this.subtitleAbort = null
    this.publishedSubtitleCount = 0
    // 递增桥接世代：否则旧会话迟到的字幕会串到下一部片。
    // 尤其切到 direct 引擎的片源时不会走 attach，不在这里作废就会污染新轨道。
    resetPlaysVideoSubtitles()
    this.destroyEngine()
    this.generation++
    delete this.video.dataset.serverDuration
  }
}

export const playsVideoEngine: PlayerEngine = {
  type: 'playsvideo',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const controller = new PlaysVideoController(video, source)
    try {
      await controller.attach(source.startTime ?? 0)
    } catch (err) {
      // attach 半途失败：终结半挂载实例，避免残留 worker 与回退引擎竞争
      controller.cleanup()
      throw err
    }
    return {
      cleanup: () => controller.cleanup(),
      player: controller,
    }
  },
}
