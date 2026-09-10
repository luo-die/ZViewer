// 统一挂载聚合 API：合并 webdav/openlist/ftp/emby/jellyfin 五个独立模块的挂载列表
// 各模块保持独立 CRUD，本模块仅提供聚合读取能力供个人中心和推送面板使用
import { getWebDAVMounts } from '@/modules/webdav/webdavApi'
import { getOpenListMounts } from '@/modules/openlist/openlistApi'
import { getFTPMounts } from '@/modules/ftp/ftpApi'
import { getEmbyMounts } from '@/modules/emby/embyApi'
import { getJellyfinMounts } from '@/modules/jellyfin/jellyfinApi'
import { apiFetch } from '@/lib/api'
import type { UnionMount, SharedMount, AnyMount } from './types'

/**
 * 获取当前用户自己的所有挂载（聚合 webdav/openlist/ftp/emby/jellyfin）
 * 任一模块失败时记录错误但不影响其他模块返回
 */
export async function fetchAllMounts(): Promise<UnionMount[]> {
  const results = await Promise.allSettled([
    getWebDAVMounts(),
    getOpenListMounts(),
    getFTPMounts(),
    getEmbyMounts(),
    getJellyfinMounts(),
  ])

  const mounts: UnionMount[] = []
  const errors: string[] = []

  results.forEach((result, index) => {
    const type = ['webdav', 'openlist', 'ftp', 'emby', 'jellyfin'][index]
    if (result.status === 'fulfilled') {
      mounts.push(...result.value)
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      errors.push(`${type}: ${msg}`)
      console.error(`[mounts] fetch ${type} mounts failed:`, result.reason)
    }
  })

  if (errors.length > 0 && mounts.length === 0) {
    throw new Error(`获取挂载列表失败：${errors.join('; ')}`)
  }

  // 按创建时间倒序
  mounts.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  return mounts
}

/**
 * 获取「别人共享给我的挂载」。
 *
 * 返回的挂载不含服务器地址/账号/密码/路径，只能用于浏览目录与在房间中添加影片。
 */
export async function fetchSharedMounts(): Promise<SharedMount[]> {
  const res = await apiFetch('/api/mounts/shared')
  const data = (await res.json()) as {
    success: boolean
    mounts?: SharedMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取共享挂载列表失败')
  }
  return data.mounts || []
}

/**
 * 获取当前用户可用的全部挂载：自己的 + 他人共享给自己的。
 *
 * 房间「添加影片」面板使用该接口——自己的挂载可自由选择直链/中转，
 * 共享挂载只能浏览与添加，播放方式跟随挂载主设置。
 */
export async function fetchAccessibleMounts(): Promise<AnyMount[]> {
  const [own, shared] = await Promise.allSettled([
    fetchAllMounts(),
    fetchSharedMounts(),
  ])

  if (own.status === 'rejected' && shared.status === 'rejected') {
    const reason = own.reason
    throw reason instanceof Error ? reason : new Error('获取挂载列表失败')
  }
  if (shared.status === 'rejected') {
    console.error('[mounts] fetch shared mounts failed:', shared.reason)
  }

  const ownMounts = own.status === 'fulfilled' ? own.value : []
  const sharedMounts = shared.status === 'fulfilled' ? shared.value : []
  return [...ownMounts, ...sharedMounts]
}
