/**
 * 自定义字幕渲染层
 *
 * 替代浏览器原生 <track> + ::cue 渲染方式，
 * 直接用 HTML/CSS 渲染 ParsedCue[]，完整保留各字幕格式的位置/对齐/样式信息。
 *
 * 设计要点：
 * - 监听 video 的 timeupdate / seeked 事件，根据当前时间查找激活的 cue
 * - 根据 cue.line / cue.position / cue.align 精确定位字幕
 * - 支持 HTML 格式文本（<b>/<i>/<u>/<s>/<br>/<span style="color:...">）
 * - pointer-events: none，不阻挡视频交互
 * - 仅当激活 cue 集合变化时更新 state，避免不必要重渲染
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ParsedCue } from '@/lib/subtitleParser'

interface SubtitleOverlayProps {
  video: HTMLVideoElement | null
  cues: ParsedCue[]
  enabled: boolean
  fontSize: number
  offset: number // 秒，正值延迟显示
  shiftX?: number // 百分比，-50~50，正值右移
  shiftY?: number // 百分比，-50~50，正值下移
  strokeWidth?: number // 描边宽度（px，0~4），0 表示无描边
  shadowBlur?: number // 阴影模糊半径（px，0~12），0 表示无阴影
  fontFamily?: string // CSS font-family，空串表示默认
  /** 副字幕轨（双语）：渲染在主字幕上方一行 */
  secondaryCues?: ParsedCue[]
}

/** 副字幕相对主字幕上移的百分比（双语时两条不重叠） */
const SECONDARY_LINE_OFFSET = 11
/** 字号缩放基准高度：720p 下 1:1，1080p 自动 ×1.5（按比例而非固定 px） */
const FONT_SIZE_REFERENCE_HEIGHT = 720

/** 计算字幕元素的 CSS transform */
function getTransform(
  line: number,
  align: 'left' | 'center' | 'right'
): string {
  const translateX =
    align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0%'
  const translateY = line > 50 ? '-100%' : '0%'
  return `translate(${translateX}, ${translateY})`
}

/** 同一槽位判定阈值：line 差值小于该值视为同一区域（百分比高度） */
const LINE_SLOT_THRESHOLD = 7
/** 槽位步进：重叠 cue 逐条下移的间距（百分比高度） */
const LINE_SLOT_STEP = 9

/**
 * 计算激活 cue 的最终垂直位置（防重叠布局）。
 *
 * 同一时刻可能存在多条激活 cue（双语字幕、ASS 多层、ffmpeg 提取的时间轴
 * 部分重叠等）。若它们声明了相同/相近的 line 位置，直接按各自 line 渲染
 * 会导致文字完全重叠不可读。
 *
 * 策略：按 line 升序遍历，每条 cue 分配到不低于前一条（+ 步进）的槽位，
 * 使重叠的 cue 垂直依次排列；无重叠的 cue 保持原始位置不变。
 */
function layoutCues(cues: ParsedCue[]): Array<ParsedCue & { resolvedLine: number }> {
  const sorted = [...cues].sort((a, b) => (a.line ?? 100) - (b.line ?? 100))
  const result: Array<ParsedCue & { resolvedLine: number }> = []
  for (const cue of sorted) {
    const base = cue.line ?? 100
    const prev = result[result.length - 1]
    const resolvedLine =
      prev && base < prev.resolvedLine + LINE_SLOT_THRESHOLD
        ? prev.resolvedLine + LINE_SLOT_STEP
        : base
    result.push({ ...cue, resolvedLine })
  }
  return result
}

export function SubtitleOverlay({
  video,
  cues,
  enabled,
  fontSize,
  offset,
  shiftX = 0,
  shiftY = 0,
  strokeWidth = 0,
  shadowBlur = 4,
  fontFamily = '',
  secondaryCues = [],
}: SubtitleOverlayProps) {
  const [activeCues, setActiveCues] = useState<ParsedCue[]>([])
  const [activeSecondary, setActiveSecondary] = useState<ParsedCue[]>([])
  // 缓存上次激活的 cue 索引字符串，避免不必要的状态更新
  const lastKeyRef = useRef('')
  /**
   * 字号按比例缩放：以播放器高度相对 720p 的比值缩放，全屏 / 小窗下字幕
   * 与画面的比例保持一致（此前是固定 px，1080p 全屏会显得很小）。
   */
  const [fontScale, setFontScale] = useState(1)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (!el) return
    const update = (): void => {
      const h = el.clientHeight || 0
      if (h > 0) {
        setFontScale(
          Math.min(3, Math.max(0.5, h / FONT_SIZE_REFERENCE_HEIGHT))
        )
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    resizeObserverRef.current = ro
  }, [])
  useEffect(() => () => resizeObserverRef.current?.disconnect(), [])

  useEffect(() => {
    if (!video || !enabled || (cues.length === 0 && secondaryCues.length === 0)) {
      setActiveCues([])
      setActiveSecondary([])
      lastKeyRef.current = ''
      return
    }

    const collect = (list: ParsedCue[], time: number): ParsedCue[] => {
      const out: ParsedCue[] = []
      for (let i = 0; i < list.length; i++) {
        if (time >= list[i].start && time < list[i].end) out.push(list[i])
      }
      return out
    }

    const update = () => {
      const time = video.currentTime - offset
      const primary = collect(cues, time)
      const secondary = collect(secondaryCues, time)
      // 仅当激活 cue 集合变化时更新 state
      const key =
        primary.map((c) => `${c.start}:${c.end}`).join('|') +
        '#' +
        secondary.map((c) => `${c.start}:${c.end}`).join('|')
      if (key !== lastKeyRef.current) {
        lastKeyRef.current = key
        setActiveCues(primary)
        setActiveSecondary(secondary)
      }
    }

    video.addEventListener('timeupdate', update)
    video.addEventListener('seeked', update)
    video.addEventListener('play', update)
    update()

    return () => {
      video.removeEventListener('timeupdate', update)
      video.removeEventListener('seeked', update)
      video.removeEventListener('play', update)
    }
  }, [video, cues, secondaryCues, enabled, offset])

  // 防重叠布局：重叠 cue 垂直堆叠而非叠字（useMemo 须在 early return 之前调用）
  // 双语：副字幕整体上移，与主字幕分行显示
  const laidOut = useMemo(() => {
    const secondary = activeSecondary.map((c) => ({
      ...c,
      line: (c.line ?? 100) - SECONDARY_LINE_OFFSET,
    }))
    return layoutCues([...activeCues, ...secondary])
  }, [activeCues, activeSecondary])

  if (!enabled || laidOut.length === 0) return null

  return (
    <div
      ref={attachContainer}
      className="pointer-events-none absolute inset-0 z-10"
      style={{ overflow: 'hidden' }}
    >
      {laidOut.map((cue, i) => {
        const line = cue.resolvedLine
        // 垂直位移叠加在防重叠布局后的行位置上（百分比容器高）
        const top = line + shiftY
        // 水平位移叠加在 cue 原始位置上（百分比容器宽）
        const position = (cue.position ?? 50) + shiftX
        const align = cue.align ?? 'center'

        return (
          <div
            key={`${cue.start}:${cue.end}:${i}`}
            dangerouslySetInnerHTML={{ __html: cue.text }}
            style={{
              position: 'absolute',
              left: `${position}%`,
              top: `${top}%`,
              transform: getTransform(line, align),
              maxWidth: '90%',
              // 按比例：字号随播放器高度缩放（1080p 全屏自动 ×1.5）
              fontSize: `${Math.round(fontSize * fontScale * 10) / 10}px`,
              lineHeight: '1.4',
              color: '#ffffff',
              backgroundColor: 'transparent',
              // 描边：paint-order 让描边画在填充之下，不侵蚀字形
              ...(strokeWidth > 0
                ? {
                    WebkitTextStroke: `${strokeWidth * fontScale}px rgba(0, 0, 0, 0.9)`,
                    paintOrder: 'stroke fill',
                  }
                : {}),
              // 阴影：模糊半径可调，0 关闭（同样按比例缩放）
              textShadow:
                shadowBlur > 0
                  ? `0 0 ${shadowBlur * fontScale}px rgba(0, 0, 0, 0.9)`
                  : 'none',
              textAlign: align,
              whiteSpace: 'pre-wrap',
              wordWrap: 'break-word',
              padding: '0 8px',
              ...(fontFamily ? { fontFamily } : {}),
            }}
          />
        )
      })}
    </div>
  )
}
