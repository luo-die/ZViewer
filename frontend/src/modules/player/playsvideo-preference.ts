/**
 * 浏览器转码引擎（playsvideo）本机偏好
 *
 * 面向所有观看者：每个人在自己浏览器上决定是否允许浏览器端重封装/转码，
 * 只写 localStorage，**不进房间状态、不经 socket 广播**——房主与观众、
 * 观众与观众之间互不影响（同一个人在多个标签页之间共享）。
 *
 * 取值：
 * - 'on'  ：本机启用（忽略影片级开关，仍按容器/音轨自动判定是否需要管线）
 * - 'off' ：本机强制原生直连（MKV/DTS 等非常规格式将无声或黑屏）
 * - null  ：未设置 → 跟随影片级开关 + 系统级开关（原行为）
 *
 * 为什么用 useSyncExternalStore 而不是 zustand：
 * shouldUsePlaysVideo 是普通函数（引擎选择、格式预检、播放器外部代码都会调用），
 * 需要一个不依赖 React 的同步读取入口；同时 UI 开关要跨组件即时同步。
 */
import { useSyncExternalStore } from 'react'

export type PlaysvideoLocalOverride = 'on' | 'off' | null

const STORAGE_KEY = 'zviewer-playsvideo-override'
const CHANGE_EVENT = 'zviewer-playsvideo-override-change'

function readFromStorage(): PlaysvideoLocalOverride {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'on' || raw === 'off') return raw
  } catch {
    /* 隐私模式等场景读不到 localStorage：按未设置处理 */
  }
  return null
}

/** 本机偏好快照（useSyncExternalStore 要求引用稳定，字符串天然稳定） */
let cached: PlaysvideoLocalOverride = readFromStorage()

/** 读取本机偏好（非 React 代码入口，例如引擎选择器） */
export function getPlaysvideoLocalOverride(): PlaysvideoLocalOverride {
  return cached
}

/** 写入本机偏好；写入后通知所有订阅组件重新渲染 */
export function setPlaysvideoLocalOverride(
  value: PlaysvideoLocalOverride
): void {
  cached = value
  try {
    if (value === null) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, value)
    }
  } catch {
    /* 写入失败（隐私模式）时仍保留内存中的值，本次会话内有效 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
  // 用户重新拨动开关 → 清掉「该源管线播不了」的会话内标记，允许再次尝试
  playsVideoFailedUrls.clear()
}

/**
 * 本次会话内「管线已确认播不了」的源地址（含标记时间）。
 *
 * 管线失败后已回退直连，但用户重载影片 / 切回同一集时再走一遍管线只会又黑屏
 * 一次（体感就是「开关一开视频就不加载」）。失败过的源在短期内直接跳过管线。
 *
 * 标记**带有效期**（而不是整会话拉黑）：一次瞬时失败（网络抖动、token 过期、
 * 上游短暂 5xx）不该让这个片源在本会话里永远用不上转码——这正是用户抱怨
 * 「这引擎时灵时不灵」的来源。过期后自动重试。
 */
const FAILURE_TTL_MS = 5 * 60_000

/** 上限：避免长时间挂机后无限增长（超出时丢弃最旧的记录） */
const FAILURE_MAX_ENTRIES = 200

const playsVideoFailedUrls = new Map<string, number>()

/** 标记某源地址的管线播放失败（回退原生直连时调用） */
export function markPlaysVideoFailure(url: string): void {
  if (!url) return
  const now = Date.now()
  // 顺带清理过期项，避免 Map 只增不减
  for (const [key, at] of playsVideoFailedUrls) {
    if (now - at > FAILURE_TTL_MS) playsVideoFailedUrls.delete(key)
  }
  if (playsVideoFailedUrls.size >= FAILURE_MAX_ENTRIES) {
    const oldest = playsVideoFailedUrls.keys().next().value
    if (oldest !== undefined) playsVideoFailedUrls.delete(oldest)
  }
  playsVideoFailedUrls.set(url, now)
}

/** 该源是否在有效期内被确认「管线播不了」 */
export function hasPlaysVideoFailure(url: string | undefined): boolean {
  if (!url) return false
  const at = playsVideoFailedUrls.get(url)
  if (at === undefined) return false
  if (Date.now() - at > FAILURE_TTL_MS) {
    playsVideoFailedUrls.delete(url)
    return false
  }
  return true
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback)
  // 多标签页：另一个标签页修改后同步本页
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function getSnapshot(): PlaysvideoLocalOverride {
  return cached
}

/** 订阅本机偏好（组件内使用） */
export function usePlaysvideoLocalOverride(): PlaysvideoLocalOverride {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 把本机偏好叠加到影片级开关上，得到最终生效的 playsvideoEnabled。
 * 引擎选择器也会直接读本机偏好，此函数供需要展示「当前生效状态」的 UI 使用。
 */
export function resolvePlaysvideoEnabled(
  movieLevel: boolean | undefined
): boolean | undefined {
  const override = cached
  if (override === 'on') return true
  if (override === 'off') return false
  return movieLevel
}
