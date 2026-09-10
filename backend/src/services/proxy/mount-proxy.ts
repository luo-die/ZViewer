/**
 * 挂载点（WebDAV / FTP / OpenList）代理的公共参数解析与挂载查询。
 *
 * 历史问题：webdav.ts / openlist.ts / ftp.ts 三个路由各自复制
 * 「mountId+path 参数校验 → 按 userId+type 查挂载 → 校验 serverUrl」逻辑。
 */

import { Response } from 'express';
import { UserMount } from '../../entities/UserMount';
import { AuthenticatedRequest } from '../../middleware/auth';
import { resolveAccessibleMount } from '../../modules/shared/mount-share';

export type MountType = 'webdav' | 'openlist' | 'ftp' | 'emby' | 'jellyfin';

export interface ResolvedMount {
  mount: UserMount;
  /** 请求的目标文件路径（已 trim，非空） */
  targetPath: string;
  /** 是否以「被共享者」身份访问他人共享给自己的挂载 */
  shared: boolean;
}

/**
 * 解析代理请求的 mountId + path，并查询当前用户可访问的挂载。
 *
 * 可访问 = 自己创建的挂载，或他人共享给自己（shareEnabled 且命中共享范围）
 * 的挂载。校验失败时直接写出错误响应并返回 null。
 */
export async function resolveUserMount(
  req: AuthenticatedRequest,
  res: Response,
  type: MountType,
): Promise<ResolvedMount | null> {
  const mountIdRaw = req.query.mountId;
  const pathRaw = req.query.path;

  if (mountIdRaw === undefined) {
    res.status(400).json({ success: false, message: '缺少 mountId 参数' });
    return null;
  }
  const mountId = Number(mountIdRaw);
  if (Number.isNaN(mountId)) {
    res.status(400).json({ success: false, message: 'mountId 不正确' });
    return null;
  }
  const targetPath = typeof pathRaw === 'string' ? pathRaw.trim() : '';
  if (!targetPath) {
    res.status(400).json({ success: false, message: '缺少 path 参数' });
    return null;
  }

  const resolved = await resolveAccessibleMount(
    mountId,
    type,
    req.user!.userId,
  );
  if (!resolved) {
    res.status(404).json({ success: false, message: '挂载不存在或无权限' });
    return null;
  }
  const { mount, shared } = resolved;
  if (!mount.serverUrl) {
    res.status(400).json({ success: false, message: '该挂载未配置服务器地址' });
    return null;
  }

  return { mount, targetPath, shared };
}
