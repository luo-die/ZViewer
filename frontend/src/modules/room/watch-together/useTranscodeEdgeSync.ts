/**
 * 服务端转码播放的「转码进度同步」。
 *
 * 背景：服务端 ffmpeg 是**顺序产出**分片的（EVENT 播放列表只追加），播放进度
 * 一旦追到已产出的边界，播放器就会停在缓冲态等后续分片。这是正常现象，
 * 但现有逻辑有两个问题：
 * 1. `useViewerStateSync` 的「画面卡死检测」（3 次心跳进度不前进）会把这种
 *    等待误判为卡死并**自动重载视频源** → 表现为「播到边界卡一下，然后跳一下」；
 * 2. 房主端全速播到边界后同样会停在缓冲态，观众跟着卡，谁都不知道在等什么。
 *
 * 本 Hook 只对「服务端转码产出的 HLS 源」生效：
 * - 房主：一旦确认是在等转码（缓冲不足且已到产出边界）就主动暂停，提示
 *   「服务器正在转码，等待后续片段…」，缓冲领先 4s 后自动继续播放；
 *   pause/play 事件由 useVideoEventBindings 广播给全房间，因此所有人停在同一点，
 *   一起等、一起继续——而不是各自卡各自的。
 * - 观众：只提示、不干预（进度由房主心跳驱动）。
 * - 房主若在等待期间手动点了播放：放弃本次托管并进入 30s 冷却，尊重用户操作。
 */
import { useEffect, useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import { safePlay } from '@/modules/sync-playback/safePlay'
import { isServerTranscodeUrl } from '@/modules/player/services/server-transcode'

/** 缓冲领先多少秒才恢复播放（够播一小段，避免刚够一帧又卡） */
const RESUME_AHEAD_SEC = 4
/** 轮询间隔 */
const POLL_MS = 1500
/** 等待超过该时长仍无新分片 → 认为转码已异常，提示并解除托管 */
const GIVE_UP_MS = 90_000
/** 用户手动播放后的冷却期（期间不再自动暂停） */
const USER_OVERRIDE_COOLDOWN_MS = 30_000

export function useTranscodeEdgeSync({
  videoRef,
  isHostRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  isHostRef: MutableRefObject<boolean>
}): void {
  const sourceUrl = useRoomStore((state) => state.watchTogether.sourceUrl)
  const waitingRef = useRef(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // 只托管服务端转码产出的 HLS 源；其他源保持原有行为
    if (!isServerTranscodeUrl(sourceUrl)) {
      waitingRef.current = false
      return
    }

    let timer: ReturnType<typeof setInterval> | null = null
    let notified = false
    let waitStartedAt = 0
    let cooldownUntil = 0

    const bufferedAhead = (): number => {
      const buffered = video.buffered
      if (!buffered || buffered.length === 0) return 0
      return buffered.end(buffered.length - 1) - video.currentTime
    }

    const stopWaiting = (resume: boolean): void => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (!waitingRef.current) return
      waitingRef.current = false
      if (resume && isHostRef.current) {
        void safePlay(video)
      }
    }

    const startWaiting = (): void => {
      if (waitingRef.current) return
      if (Date.now() < cooldownUntil) return
      waitingRef.current = true
      waitStartedAt = Date.now()
      if (!notified) {
        notified = true
        message.info('服务器正在转码，等待后续片段…', { duration: 6000 })
      }
      // 房主：暂停等待缓冲，避免「卡一下再跳」的观感；
      // pause 事件会被广播，全房间一起停在同一点
      if (isHostRef.current) {
        try {
          video.pause()
        } catch {
          /* ignore */
        }
      }
      if (timer) return
      timer = setInterval(() => {
        if (!waitingRef.current) {
          if (timer) {
            clearInterval(timer)
            timer = null
          }
          return
        }
        if (bufferedAhead() >= RESUME_AHEAD_SEC) {
          stopWaiting(true)
          return
        }
        if (Date.now() - waitStartedAt > GIVE_UP_MS) {
          stopWaiting(true)
          message.warning(
            '服务端转码似乎已停止产出新片段，可重载影片或检查服务器 ffmpeg',
            { duration: 8000 }
          )
        }
      }, POLL_MS)
    }

    /** 已到产出边界（缓冲几乎没领先）才判定为「在等转码」 */
    const onWaiting = (): void => {
      if (bufferedAhead() >= 1.5) return
      startWaiting()
    }
    const onProgress = (): void => {
      if (waitingRef.current && bufferedAhead() >= RESUME_AHEAD_SEC) {
        stopWaiting(true)
      }
    }
    /** 用户手动播放：放弃本次托管，避免与用户操作互相拉扯 */
    const onPlay = (): void => {
      if (!waitingRef.current) return
      stopWaiting(false)
      cooldownUntil = Date.now() + USER_OVERRIDE_COOLDOWN_MS
    }

    video.addEventListener('waiting', onWaiting)
    video.addEventListener('stalled', onWaiting)
    video.addEventListener('progress', onProgress)
    video.addEventListener('timeupdate', onProgress)
    video.addEventListener('play', onPlay)

    return () => {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('stalled', onWaiting)
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('timeupdate', onProgress)
      video.removeEventListener('play', onPlay)
      if (timer) clearInterval(timer)
      waitingRef.current = false
    }
  }, [sourceUrl, videoRef, isHostRef])
}
