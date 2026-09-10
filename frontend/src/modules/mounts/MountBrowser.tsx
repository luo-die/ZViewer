// 统一挂载浏览器：按挂载类型分流到对应模块的独立浏览器
import type { WebDAVMount } from '@/modules/webdav/types'
import type { OpenListMount } from '@/modules/openlist/types'
import type { FTPMount } from '@/modules/ftp/types'
import type { EmbyMount } from '@/modules/emby/types'
import type { JellyfinMount } from '@/modules/jellyfin/types'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import FTPBrowser from '@/modules/ftp/FTPBrowser'
import EmbyBrowser from '@/modules/emby/EmbyBrowser'
import JellyfinBrowser from '@/modules/jellyfin/JellyfinBrowser'
import type { AnyMount } from './types'
import {
  isWebDAVMount,
  isOpenListMount,
  isFTPMount,
  isEmbyMount,
  isJellyfinMount,
} from './types'

interface MountBrowserProps {
  /** 自己的挂载或他人共享给自己的挂载（共享挂载同样支持浏览） */
  mount: AnyMount | null
  open: boolean
  onClose: () => void
  onSelectFile?: (path: string) => void
  /**
   * 批量选中回调。
   * entries 为可读条目（路径 + 展示名），Emby/Jellyfin 用它给剧集生成标题；
   * WebDAV/OpenList/FTP 等文件型挂载不传（沿用文件名推断标题）。
   */
  onSelectFiles?: (
    paths: string[],
    entries?: Array<{ path: string; name: string }>
  ) => void
  selectable?: boolean
}

export default function MountBrowser({
  mount,
  open,
  onClose,
  onSelectFile,
  onSelectFiles,
  selectable = false,
}: MountBrowserProps) {
  const handleFiles = (
    paths: string[],
    entries?: Array<{ path: string; name: string }>
  ) => {
    if (onSelectFiles) {
      onSelectFiles(paths, entries)
    } else if (onSelectFile && paths[0]) {
      onSelectFile(paths[0])
    }
    onClose()
  }

  if (mount && isWebDAVMount(mount)) {
    return (
      <WebDAVBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isOpenListMount(mount)) {
    return (
      <OpenListBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isFTPMount(mount)) {
    return (
      <FTPBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isEmbyMount(mount)) {
    return (
      <EmbyBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isJellyfinMount(mount)) {
    return (
      <JellyfinBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  // mount 为 null 时返回一个不可见的占位 Modal，保持 hook 调用数稳定
  return (
    <WebDAVBrowser
      mountId={null}
      open={open}
      onClose={onClose}
      onSelectFiles={undefined}
      selectable={selectable}
    />
  )
}

// 重新导出各类型，方便调用方使用
export type { WebDAVMount, OpenListMount, FTPMount, EmbyMount, JellyfinMount }
