/**
 * 影片切换时强制重挂载播放器的 key 生成器。
 *
 * 背景：视频列表中切换不同添加方式的影片（如 Bilibili DASH → WebDAV MKV）
 * 意味着跨引擎切换（dashjs → playsvideo 等）。旧引擎的 MSE SourceBuffer /
 * 转码 worker / fetch 流即使经过 cleanup，残留状态仍可能与新引擎冲突导致
 * 播放器卡死。为 WatchTogetherPanel 绑定本 hook 返回的 key，切换影片时
 * 整个播放器（ArtPlayer 实例 + video 元素 + 全部业务 Hook）随 key 重挂载，
 * 实现彻底干净的全量重载。
 *
 * 语义：
 * - 首次观察到的 currentMovieId 不触发 key 变化——首次挂载本来就是全新
 *   attach（无旧引擎残留），避免进房 / 刷新恢复时无谓的双重加载；
 * - 之后的 currentMovieId 变化（切换影片）→ key 跟随影片 id，整个
 *   WatchTogetherPanel 重挂载；
 * - currentMovieId 被清空（删除当前影片）不改 key，沿用现有的
 *   清理 effect 暂停视频即可。
 */
import { useEffect, useRef, useState } from 'react'
import { useRoomStore } from '@/store/roomStore'

export function usePlayerRemountKey(): string | number {
  const currentMovieId = useRoomStore((s) => s.currentMovieId)
  const roomId = useRoomStore((s) => s.roomId)
  const [remountKey, setRemountKey] = useState<string | number>('init')
  const prevMovieIdRef = useRef<number | null>(null)
  const prevRoomIdRef = useRef<string>('')

  useEffect(() => {
    if (currentMovieId == null) return
    const prev = prevMovieIdRef.current
    prevMovieIdRef.current = currentMovieId
    // 首次观察或重复设置同一影片：不重挂载
    if (prev == null || prev === currentMovieId) return
    setRemountKey(currentMovieId)
  }, [currentMovieId])

  /**
   * 切换房间 → 强制重挂载整个播放器。
   *
   * 换房间时 socket 不重连、<video> 元素也不重建，旧房间残留的引擎实例
   * （MSE SourceBuffer / 转码 worker / 在途 fetch）与已缓冲的旧片源会跟着
   * 进入新房间，表现为「在新房间点播放，放的却是上一个房间的内容」。
   * 换房间时换 key，让播放器连同全部业务 Hook 一起干净重建。
   */
  useEffect(() => {
    const prev = prevRoomIdRef.current
    prevRoomIdRef.current = roomId
    if (!roomId || !prev || prev === roomId) return
    setRemountKey(`room:${roomId}:${Date.now()}`)
  }, [roomId])

  return remountKey
}
