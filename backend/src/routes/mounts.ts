/**
 * 个人挂载共享路由（挂载在 /api/mounts）。
 *
 * - GET   /api/mounts/users            可选共享目标用户列表（供共享设置弹窗）
 * - GET   /api/mounts/shared           别人共享给我的挂载（不含任何连接信息）
 * - PUT   /api/mounts/:type/:id/share  设置某挂载的共享范围（仅挂载主）
 *
 * 各类型挂载自身的 CRUD 仍在 /api/webdav|openlist|ftp|emby|jellyfin 下，
 * 此路由只承载「跨类型」的共享能力，避免 5 份重复实现。
 */
import { Router, type Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount, type MountType } from '../entities/UserMount';
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth';
import {
  MOUNT_TYPES,
  listShareTargets,
  listSharedMountsFor,
  normalizeShareSettings,
  toOwnMountDto,
} from '../modules/shared/mount-share';

const router = Router();

router.use(authenticateToken);

function parseMountType(raw: unknown): MountType | null {
  const value = String(raw ?? '').toLowerCase();
  return (MOUNT_TYPES as string[]).includes(value)
    ? (value as MountType)
    : null;
}

// 可选共享目标用户列表
router.get(
  '/users',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user!.userId;
      if (userId <= 0) {
        res.status(403).json({ success: false, message: '游客无法共享挂载' });
        return;
      }
      const users = await listShareTargets(userId);
      res.json({ success: true, users });
    } catch (err) {
      console.error('[mounts] list share targets error:', err);
      res.status(500).json({ success: false, message: '获取用户列表失败' });
    }
  },
);

// 别人共享给我的挂载
router.get(
  '/shared',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const mounts = await listSharedMountsFor(userId);
      res.json({ success: true, mounts });
    } catch (err) {
      console.error('[mounts] list shared mounts error:', err);
      res.status(500).json({ success: false, message: '获取共享挂载列表失败' });
    }
  },
);

// 设置共享（仅挂载主）
router.put(
  '/:type/:id/share',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const type = parseMountType(req.params.type);
      if (!type) {
        res.status(400).json({ success: false, message: '挂载类型不正确' });
        return;
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ success: false, message: '挂载 ID 不正确' });
        return;
      }

      const repo = AppDataSource.getRepository(UserMount);
      const mount = await repo.findOneBy({ id, type, userId: req.user!.userId });
      if (!mount) {
        res.status(404).json({ success: false, message: '挂载不存在或无权限' });
        return;
      }

      const settings = normalizeShareSettings(req.body ?? {});
      mount.shareEnabled = settings.shareEnabled;
      mount.shareScope = settings.shareScope;
      mount.sharedUserIds = JSON.stringify(settings.sharedUserIds);
      await repo.save(mount);

      res.json({ success: true, mount: toOwnMountDto(mount) });
    } catch (err) {
      console.error('[mounts] update share settings error:', err);
      res.status(500).json({ success: false, message: '设置共享失败' });
    }
  },
);

export default router;
