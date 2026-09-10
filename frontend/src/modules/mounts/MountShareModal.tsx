// 挂载共享设置弹窗（个人中心「共享」按钮）
// 挂载主可把挂载共享给指定用户或全部用户；
// 被共享者仅能浏览片源并在房间中添加影片，看不到连接信息，也无法更改播放方式。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Share2, UserCheck } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Spinner } from '@/components/ui/Spinner'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import {
  fetchShareTargets,
  updateMountShare,
  type ShareTargetUser,
} from './mountShareApi'
import type { MountType, ShareScope, UnionMount } from './types'

const TYPE_LABELS: Record<MountType, string> = {
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
  emby: 'Emby',
  jellyfin: 'Jellyfin',
}

interface MountShareModalProps {
  open: boolean
  mount: UnionMount | null
  onClose: () => void
  /** 保存成功后回调（父组件刷新列表） */
  onSaved?: () => void
}

export default function MountShareModal({
  open,
  mount,
  onClose,
  onSaved,
}: MountShareModalProps) {
  const [enabled, setEnabled] = useState(false)
  const [scope, setScope] = useState<ShareScope>('selected')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [users, setUsers] = useState<ShareTargetUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [saving, setSaving] = useState(false)

  // 打开弹窗时用挂载现有共享配置初始化
  useEffect(() => {
    if (!open || !mount) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时同步挂载的共享配置
    setEnabled(mount.shareEnabled === true)
    setScope(mount.shareScope === 'all' ? 'all' : 'selected')
    setSelectedIds(
      Array.isArray(mount.sharedUserIds) ? mount.sharedUserIds : []
    )
    setKeyword('')
  }, [open, mount])

  useEffect(() => {
    if (!open) return
    let mounted = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开弹窗时拉取可选用户列表
    setUsersLoading(true)
    fetchShareTargets()
      .then((list) => {
        if (mounted) setUsers(list)
      })
      .catch((err) => {
        if (mounted) {
          message.error(err instanceof Error ? err.message : '获取用户列表失败')
        }
      })
      .finally(() => {
        if (mounted) setUsersLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [open])

  const filteredUsers = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return users
    return users.filter((u) => u.username.toLowerCase().includes(kw))
  }, [users, keyword])

  const toggleUser = useCallback((id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }, [])

  const handleSave = useCallback(async () => {
    if (!mount) return
    if (enabled && scope === 'selected' && selectedIds.length === 0) {
      message.warning('请至少选择一个用户，或改为「全部用户」')
      return
    }
    setSaving(true)
    try {
      await updateMountShare(mount.type, mount.id, {
        shareEnabled: enabled,
        shareScope: scope,
        sharedUserIds: selectedIds,
      })
      message.success(enabled ? '共享设置已保存' : '已关闭该挂载的共享')
      onSaved?.()
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存共享设置失败')
    } finally {
      setSaving(false)
    }
  }, [mount, enabled, scope, selectedIds, onSaved, onClose])

  if (!mount) {
    return (
      <Modal open={false} onClose={onClose} title="共享挂载">
        <span />
      </Modal>
    )
  }

  const selectedCount = selectedIds.length

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Share2 className="h-4 w-4" />
          共享挂载
        </span>
      }
      className="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            onClick={() => void handleSave()}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2">
          <div className="min-w-0">
            <Text className="block truncate text-sm font-medium">
              {mount.name}
            </Text>
            <Text type="secondary" className="block text-[11px]">
              {TYPE_LABELS[mount.type]}
            </Text>
          </div>
          <Switch
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            label="共享"
          />
        </div>

        <Text type="secondary" className="text-[11px] leading-relaxed">
          被共享者只能浏览该挂载的片源，并在自己管理的房间中添加影片；
          服务器地址、账号、密码不会下发给他们。播放方式（直链 / 中转）
          与你的挂载设置保持一致，他们无法自行更改。
        </Text>

        {enabled && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Text className="text-xs font-medium">共享给</Text>
              <SegmentedToggle
                options={[
                  { value: 'selected', label: '指定用户' },
                  { value: 'all', label: '全部用户' },
                ]}
                value={scope}
                onChange={(value) => setScope(value as ShareScope)}
              />
            </div>

            {scope === 'all' ? (
              <div className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline-variant)] px-3 py-2">
                <UserCheck className="h-4 w-4 shrink-0" />
                <Text className="text-xs">
                  所有已登录用户都可以使用该挂载（包括之后新注册的用户）。
                </Text>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="搜索用户名"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSelectedIds((prev) => {
                        const ids = new Set(prev)
                        for (const u of filteredUsers) ids.add(u.id)
                        return [...ids]
                      })
                    }
                    disabled={filteredUsers.length === 0}
                  >
                    全选
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedIds([])}
                    disabled={selectedCount === 0}
                  >
                    清空
                  </Button>
                </div>

                <div className="zen-scroll max-h-56 overflow-y-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline-variant)]">
                  {usersLoading ? (
                    <div className="py-6">
                      <Spinner tip="加载用户列表..." size={24} />
                    </div>
                  ) : filteredUsers.length === 0 ? (
                    <div className="px-3 py-6 text-center">
                      <Text type="secondary" className="text-xs">
                        {users.length === 0
                          ? '暂无可共享的用户'
                          : '没有匹配的用户'}
                      </Text>
                    </div>
                  ) : (
                    filteredUsers.map((u) => {
                      const checked = selectedIds.includes(u.id)
                      return (
                        <button
                          key={u.id}
                          type="button"
                          onClick={() => toggleUser(u.id)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                            'hover:bg-[var(--md-sys-color-surface-container-high)]'
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                              checked
                                ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]'
                                : 'border-[var(--md-sys-color-outline)]'
                            )}
                          >
                            {checked && <UserCheck className="h-2.5 w-2.5" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {u.username}
                          </span>
                          {u.role === 'root' || u.role === 'admin' ? (
                            <span className="shrink-0 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                              管理员
                            </span>
                          ) : null}
                        </button>
                      )
                    })
                  )}
                </div>
                <Text type="secondary" className="text-[11px]">
                  已选择 {selectedCount} 位用户
                </Text>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
