/**
 * 挂载共享 API（个人中心「共享」按钮使用）。
 *
 * - GET  /api/mounts/users            可选共享目标用户
 * - PUT  /api/mounts/:type/:id/share  保存某挂载的共享范围
 */
import { apiFetch } from '@/lib/api'
import type { MountType, ShareScope } from './types'

/** 可共享目标用户（后端已排除自己、游客与待审核用户） */
export interface ShareTargetUser {
  id: number
  username: string
  role: string
}

export interface ShareSettingsPayload {
  shareEnabled: boolean
  shareScope: ShareScope
  sharedUserIds: number[]
}

/** 获取可共享的用户列表 */
export async function fetchShareTargets(): Promise<ShareTargetUser[]> {
  const res = await apiFetch('/api/mounts/users')
  const data = (await res.json()) as {
    success: boolean
    users?: ShareTargetUser[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取用户列表失败')
  }
  return data.users || []
}

/** 保存挂载共享设置（仅挂载主可调用） */
export async function updateMountShare(
  type: MountType,
  id: number,
  payload: ShareSettingsPayload
): Promise<void> {
  const res = await apiFetch(
    `/api/mounts/${encodeURIComponent(type)}/${id}/share`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '保存共享设置失败')
  }
}
