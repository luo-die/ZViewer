// 统一挂载管理组件（个人中心使用）
// 聚合展示 webdav/openlist/ftp 三种挂载，添加/编辑/浏览分别委托给各模块独立组件
import { useCallback, useEffect, useState } from 'react'
import {
  FolderOpen,
  Globe,
  HardDrive,
  Link,
  Pencil,
  Plus,
  Server,
  Share2,
  Trash2,
  Clapperboard,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { deleteWebDAVMount } from '@/modules/webdav/webdavApi'
import { deleteOpenListMount } from '@/modules/openlist/openlistApi'
import { deleteFTPMount } from '@/modules/ftp/ftpApi'
import { deleteEmbyMount } from '@/modules/emby/embyApi'
import { deleteJellyfinMount } from '@/modules/jellyfin/jellyfinApi'
import { fetchAllMounts, fetchSharedMounts } from './mountsApi'
import MountFormModal from './MountFormModal'
import MountBrowser from './MountBrowser'
import MountShareModal from './MountShareModal'
import type { UnionMount, SharedMount, MountType } from './types'

const TYPE_LABELS: Record<MountType, string> = {
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
  emby: 'Emby',
  jellyfin: 'Jellyfin',
}

const TYPE_COLORS: Record<MountType, 'primary' | 'warning' | 'success'> = {
  webdav: 'primary',
  ftp: 'warning',
  openlist: 'success',
  emby: 'primary',
  jellyfin: 'primary',
}

const TYPE_ICONS: Record<MountType, React.ReactNode> = {
  webdav: <Server className="h-4 w-4" />,
  ftp: <HardDrive className="h-4 w-4" />,
  openlist: <Globe className="h-4 w-4" />,
  emby: <Clapperboard className="h-4 w-4" />,
  jellyfin: <Clapperboard className="h-4 w-4" />,
}

export default function MountManager() {
  const [mounts, setMounts] = useState<UnionMount[]>([])
  const [sharedMounts, setSharedMounts] = useState<SharedMount[]>([])
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editingMount, setEditingMount] = useState<UnionMount | null>(null)
  const [initialType, setInitialType] = useState<MountType>('webdav')
  const [deleteTarget, setDeleteTarget] = useState<UnionMount | null>(null)
  const [browsingMount, setBrowsingMount] = useState<UnionMount | null>(null)
  const [shareTarget, setShareTarget] = useState<UnionMount | null>(null)
  const [deleting, setDeleting] = useState(false)

  const loadMounts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAllMounts()
      setMounts(data)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取挂载列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 他人共享给我的挂载：只读，仅用于房间内添加影片
  const loadSharedMounts = useCallback(async () => {
    try {
      const data = await fetchSharedMounts()
      setSharedMounts(data)
    } catch (err) {
      console.error('[MountManager] fetch shared mounts error:', err)
    }
  }, [])

  const reloadAll = useCallback(async () => {
    await Promise.all([loadMounts(), loadSharedMounts()])
  }, [loadMounts, loadSharedMounts])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初始化加载挂载列表
    void reloadAll()
  }, [reloadAll])

  const openAddModal = (type: MountType = 'webdav') => {
    setEditingMount(null)
    setInitialType(type)
    setFormOpen(true)
  }

  const openEditModal = (mount: UnionMount) => {
    setEditingMount(mount)
    setFormOpen(true)
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.type === 'webdav') {
        await deleteWebDAVMount(deleteTarget.id)
      } else if (deleteTarget.type === 'openlist') {
        await deleteOpenListMount(deleteTarget.id)
      } else if (deleteTarget.type === 'emby') {
        await deleteEmbyMount(deleteTarget.id)
      } else if (deleteTarget.type === 'jellyfin') {
        await deleteJellyfinMount(deleteTarget.id)
      } else {
        await deleteFTPMount(deleteTarget.id)
      }
      message.success('挂载已删除')
      await loadMounts()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除挂载失败')
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  return (
    <div className="glass-card p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-secondary-container)',
              color: 'var(--md-sys-color-on-secondary-container)',
            }}
          >
            <Server className="h-4 w-4" />
          </div>
          <Text className="text-sm font-medium">我的挂载</Text>
        </div>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={() => openAddModal('webdav')}
        >
          添加挂载
        </Button>
      </div>

      {loading && mounts.length === 0 ? (
        <div className="py-6">
          <Spinner tip="加载挂载列表..." size={28} />
        </div>
      ) : mounts.length === 0 ? (
        <div className="py-6 text-center">
          <Text type="secondary" className="text-sm">
            暂无保存的挂载配置
          </Text>
        </div>
      ) : (
        <div className="space-y-3">
          {mounts.map((mount) => {
            const subtitle =
              [mount.serverUrl, 'path' in mount ? mount.path : null]
                .filter(Boolean)
                .join(' / ') || null
            return (
              <div
                key={`${mount.type}-${mount.id}`}
                className="glass flex items-start gap-3 rounded-[var(--md-sys-shape-corner)] p-3 transition-colors"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                >
                  {TYPE_ICONS[mount.type]}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Tag color={TYPE_COLORS[mount.type]}>
                      {TYPE_LABELS[mount.type]}
                    </Tag>
                    <Text className="truncate text-sm font-medium">
                      {mount.name}
                    </Text>
                  </div>
                  {subtitle && (
                    <div className="flex items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      <Link className="h-3 w-3 shrink-0" />
                      <span className="truncate">{subtitle}</span>
                    </div>
                  )}
                  {'port' in mount && mount.port && (
                    <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      端口：{mount.port}
                    </div>
                  )}
                  {(mount.type === 'openlist' ||
                    mount.type === 'webdav' ||
                    mount.type === 'emby' ||
                    mount.type === 'jellyfin') && (
                    <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      播放模式：{mount.directLink ? '直链' : '转发'}
                    </div>
                  )}
                  {mount.username && (
                    <div className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      用户：{mount.username}
                    </div>
                  )}
                  {mount.shareEnabled && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-[var(--md-sys-color-primary)]">
                      <Users className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {mount.shareScope === 'all'
                          ? '已共享给全部用户'
                          : `已共享给 ${mount.sharedUserIds?.length ?? 0} 位用户`}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<FolderOpen className="h-4 w-4" />}
                    onClick={() => setBrowsingMount(mount)}
                  >
                    浏览
                  </Button>
                  <Button
                    variant={mount.shareEnabled ? 'secondary' : 'ghost'}
                    size="sm"
                    icon={<Share2 className="h-4 w-4" />}
                    onClick={() => setShareTarget(mount)}
                  >
                    共享
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pencil className="h-4 w-4" />}
                    onClick={() => openEditModal(mount)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setDeleteTarget(mount)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 他人共享给我的挂载：只读，仅可在房间内添加影片时使用 */}
      {sharedMounts.length > 0 && (
        <div className="mt-5 border-t border-[var(--glass-border)] pt-4">
          <div className="mb-3 flex items-center gap-2">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
              style={{
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
                color: 'var(--md-sys-color-on-tertiary-container)',
              }}
            >
              <Share2 className="h-3.5 w-3.5" />
            </div>
            <Text className="text-sm font-medium">他人共享给我的挂载</Text>
          </div>
          <Text
            type="secondary"
            className="mb-3 block text-[11px] leading-relaxed"
          >
            这些挂载由其他用户共享给你，连接信息对他们可见但对你隐藏。
            你只能在房间的「添加影片」中使用它们（浏览片源并加入播放列表）；
            播放方式（直链 / 中转）与共享者的设置保持一致，无法自行更改。
          </Text>
          <div className="space-y-2">
            {sharedMounts.map((mount) => (
              <div
                key={`shared-${mount.type}-${mount.id}`}
                className="glass flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] p-3"
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor: 'var(--md-sys-color-tertiary-container)',
                    color: 'var(--md-sys-color-on-tertiary-container)',
                  }}
                >
                  {TYPE_ICONS[mount.type]}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Tag color={TYPE_COLORS[mount.type]}>
                      {TYPE_LABELS[mount.type]}
                    </Tag>
                    <Text className="truncate text-sm font-medium">
                      {mount.name}
                    </Text>
                    <Tag color="default">共享</Tag>
                  </div>
                  <div className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    来自：{mount.ownerName || `用户 #${mount.ownerUserId}`} ·
                    播放方式：{mount.directLink ? '直链' : '中转'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <MountFormModal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={loadMounts}
        editingMount={editingMount}
        initialType={initialType}
      />

      <MountShareModal
        open={!!shareTarget}
        mount={shareTarget}
        onClose={() => setShareTarget(null)}
        onSaved={loadMounts}
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
        onOk={handleDelete}
        okText={deleting ? '删除中...' : '删除'}
        cancelText="取消"
      >
        确定要删除挂载「{deleteTarget?.name}」吗？删除后不可恢复。
      </ConfirmModal>

      <MountBrowser
        mount={browsingMount}
        open={!!browsingMount}
        onClose={() => setBrowsingMount(null)}
      />
    </div>
  )
}
