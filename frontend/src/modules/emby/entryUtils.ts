/**
 * 媒体库条目展示工具（Emby / Jellyfin 共用）
 *
 * 从 EmbyBrowser 抽出来单独成文件：
 * 组件文件只导出组件（react-refresh/only-export-components）。
 */
import type { EmbyDirectoryEntry } from './types'

/** 单集编号（S01E02）：季号缺失时只显示 E02 */
export function formatEpisodeCode(entry: {
  indexNumber?: number | null
  parentIndexNumber?: number | null
}): string {
  if (entry.indexNumber == null) return ''
  const ep = `E${String(entry.indexNumber).padStart(2, '0')}`
  if (entry.parentIndexNumber == null) return ep
  return `S${String(entry.parentIndexNumber).padStart(2, '0')}${ep}`
}

/**
 * 列表展示名 / 批量添加时的影片标题。
 * 单集拼上 S01E02 前缀（Emby 的 Name 只有单集标题，单独看不出是第几集）。
 */
export function formatEntryTitle(entry: EmbyDirectoryEntry): string {
  const code = formatEpisodeCode(entry)
  return code ? `${code} ${entry.name}` : entry.name
}
