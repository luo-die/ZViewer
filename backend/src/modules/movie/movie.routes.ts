/**
 * 影片 REST API 路由。
 *
 * 挂载在 /api/rooms/:roomId/movies 下，提供影片 CRUD 与重排序接口。
 *
 * 设计目的：
 * - 消除旧架构中 routes/rooms.ts 内联的影片 REST 路由
 * - 所有写操作完成后统一调用 movieBroadcasterService.broadcastMovieList 广播
 * - 权限校验：root 或房间 owner（通过 Room.ownerUserId 判断）
 *
 * 路由列表：
 * - GET    /api/rooms/:roomId/movies           获取影片列表
 * - POST   /api/rooms/:roomId/movies           新增影片
 * - POST   /api/rooms/:roomId/movies/reorder   批量重排序
 * - PUT    /api/rooms/:roomId/movies/:movieId   更新影片
 * - DELETE /api/rooms/:roomId/movies/:movieId   删除影片
 */
import { Router, type Response } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { UserMount } from '../../entities/UserMount';
import { Movie as MovieEntity } from '../../entities/Movie';
import {
  authenticateToken,
  type AuthenticatedRequest,
} from '../../middleware/auth';
import { movieService } from './movie.service';
import { movieBroadcasterService } from './movie-broadcaster.service';
import { roomStateService } from '../room/room-state.service';
import { isInternalOpenListServer } from '../../services/openlist-errors';
import {
  MOUNT_TYPES,
  canUseDirectLink,
  resolveAccessibleMount,
} from '../shared/mount-share';
import type { MountType } from '../../entities/UserMount';
import type { MovieDto } from '../shared';

/**
 * 校验请求方是否有权限操作房间影片（root 或房间 owner）。
 *
 * 与旧架构 routes/rooms.ts 的 canControlRoom 保持一致：
 * - root 角色：允许
 * - admin 角色 + room.ownerUserId === userId：允许
 * - 其他：拒绝
 */
function canControlRoom(req: AuthenticatedRequest, room: Room): boolean {
  const role = req.user?.role;
  if (role === 'root') return true;
  if (role === 'admin' && room.ownerUserId === req.user?.userId) return true;
  return false;
}

/**
 * 创建影片 REST 路由。
 *
 * @param io Socket.IO 服务实例，用于广播影片列表变更
 */
export function createMovieRouter(io: SocketIOServer): Router {
  const router = Router();

  // 所有路由都需要登录认证
  router.use(authenticateToken);

  // GET /api/rooms/:roomId/movies - 获取影片列表
  router.get(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movies = await movieService.listMovies(roomId);
        res.json({ success: true, movies });
      } catch (err) {
        console.error('[GET /movies] error:', err);
        res.status(500).json({ success: false, message: '获取影片列表失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies - 新增影片（仅 root 或房间 owner）
  router.post(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可新增影片' });
          return;
        }

        const data = req.body as Partial<MovieDto>;
        if (typeof data.url !== 'string' || !data.url.trim() || typeof data.title !== 'string' || !data.title.trim()) {
          res.status(400).json({ success: false, message: 'url 和 title 为必填项' });
          return;
        }

        const sourceType = typeof data.source === 'string' ? data.source.toLowerCase() : '';

        // 挂载来源：优先用前端传的 mountId 解析（自己的挂载或他人共享给自己的）。
        // 被共享者拿不到 serverUrl/凭证，只能传 mountId —— 后端补齐凭证，
        // 并让播放方式跟随挂载主的 directLink 设置（被共享者无权选择）。
        const mountIdRaw = data.mountId;
        if (typeof mountIdRaw === 'number' && Number.isFinite(mountIdRaw)) {
          if (!(MOUNT_TYPES as string[]).includes(sourceType)) {
            res.status(400).json({ success: false, message: 'mountId 仅适用于挂载类来源' });
            return;
          }
          const access = await resolveAccessibleMount(
            mountIdRaw,
            sourceType as MountType,
            req.user!.userId,
          );
          if (!access) {
            res.status(404).json({ success: false, message: '挂载不存在或无权限' });
            return;
          }
          const { mount, shared } = access;
          data.serverUrl = mount.serverUrl ?? undefined;
          if (shared) {
            // 被共享者：连接信息与播放方式全部以挂载配置为准，不接受请求体覆盖
            data.username = mount.username ?? undefined;
            data.password = mount.password ?? undefined;
            data.directLink = canUseDirectLink(mount, shared);
          } else {
            data.username = data.username || mount.username || undefined;
            data.password = data.password || mount.password || undefined;
          }
          // mountId 只是解析入口，不落库
          delete (data as { mountId?: number }).mountId;
        }

        // WebDAV / OpenList：前端不传凭证（挂载列表 API 不返回密码），
        // 后端从 UserMount 表按 userId + serverUrl 自动补全。
        if ((sourceType === 'webdav' || sourceType === 'openlist') && data.serverUrl) {
          if (!data.username || !data.password) {
            const mount = await AppDataSource.getRepository(UserMount).findOneBy({
              userId: req.user!.userId,
              serverUrl: data.serverUrl,
              type: sourceType as 'webdav' | 'openlist',
            });
            if (mount) {
              if (!data.username && mount.username) data.username = mount.username;
              if (!data.password && mount.password) data.password = mount.password;
            }
          }
        }

        // 内网地址强制使用服务器中转（浏览器尤其公网访问者无法直连内网服务器）。
        // 覆盖全部挂载型源：emby/jellyfin 的直链 URL 同样指向挂载的 NAS 服务器，
        // 与 openlist/webdav 的 raw_url 内网语义一致。
        if (
          data.directLink === true &&
          (sourceType === 'openlist' ||
            sourceType === 'webdav' ||
            sourceType === 'emby' ||
            sourceType === 'jellyfin')
        ) {
          // emby/jellyfin 优先用 serverUrl 判断；缺失时回退用直链 URL 的 host 判断
          const serverUrlForCheck =
            data.serverUrl ||
            (typeof data.url === 'string' && data.url ? data.url : '');
          if (serverUrlForCheck && isInternalOpenListServer(serverUrlForCheck)) {
            data.directLink = false;
          }
        }

        const movie = await movieService.createMovie(roomId, data);
        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.status(201).json({ success: true, movie });
      } catch (err) {
        console.error('[POST /movies] error:', err);
        res.status(500).json({ success: false, message: '新增影片失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/movies/reorder - 批量重排序（仅 root 或房间 owner）
  router.post(
    '/:roomId/movies/reorder',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const body = req.body as {
          orders?: { id: number; order: number }[];
          orderedIds?: unknown;
        };
        // 兼容两种排序格式：
        // - orderedIds: number[]（前端 roomStore.reorderMovies 使用的格式）
        // - orders: { id, order }[]（显式指定 order 值）
        let orders: { id: number; order: number }[] | undefined = undefined;
        if (Array.isArray(body.orders)) {
          orders = body.orders;
        } else if (Array.isArray(body.orderedIds)) {
          orders = body.orderedIds.map((id, i) => ({ id: Number(id), order: i }));
        }
        if (!orders) {
          res.status(400).json({ success: false, message: 'orders/orderedIds 必须是数组' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可重排序影片' });
          return;
        }

        await movieService.reorderMovies(roomId, orders);
        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('[POST /movies/reorder] error:', err);
        res.status(500).json({ success: false, message: '重排序失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/movies/:movieId - 更新影片（仅 root 或房间 owner）
  router.put(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        if (!Number.isFinite(movieId)) {
          res.status(400).json({ success: false, message: 'movieId 无效' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可更新影片' });
          return;
        }

        const data = req.body as Partial<MovieDto>;

        // 内网地址强制使用服务器中转：检查更新后的 serverUrl / 直链 URL
        //（若均未传则查询现有影片的 serverUrl / url）
        if (data.directLink === true) {
          const MOUNT_SOURCES = ['openlist', 'webdav', 'emby', 'jellyfin'];
          const serverUrlToCheck = typeof data.serverUrl === 'string' && data.serverUrl
            ? data.serverUrl
            : typeof data.url === 'string' && data.url
              ? data.url
              : null;
          if (serverUrlToCheck && isInternalOpenListServer(serverUrlToCheck)) {
            data.directLink = false;
          } else if (!serverUrlToCheck) {
            // 未传 serverUrl/url，查询现有影片判断
            const existing = await AppDataSource.getRepository(MovieEntity).findOneBy({
              id: movieId,
              roomId,
            });
            const existingServerUrl = existing?.serverUrl || undefined;
            const existingSource = (existing?.source || '').toLowerCase();
            if (
              MOUNT_SOURCES.includes(existingSource) &&
              existingServerUrl &&
              isInternalOpenListServer(existingServerUrl)
            ) {
              data.directLink = false;
            } else if (
              MOUNT_SOURCES.includes(existingSource) &&
              existing?.url &&
              isInternalOpenListServer(existing.url)
            ) {
              data.directLink = false;
            }
          }
        }

        const updated = await movieService.updateMovie(roomId, movieId, data);
        if (!updated) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true, movie: updated });
      } catch (err) {
        console.error('[PUT /movies/:movieId] error:', err);
        res.status(500).json({ success: false, message: '更新影片失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/movies - 清空播放列表（仅 root 或房间 owner）
  // 注意：必须注册在 /:roomId/movies/:movieId 之前也可（路径段数不同，无冲突）
  router.delete(
    '/:roomId/movies',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可清空播放列表' });
          return;
        }

        const removed = await movieService.clearMovies(roomId);
        // 清空后当前影片必然失效：清内存状态并广播，避免客户端继续播放已删除的影片
        roomStateService.setCurrentMovie(roomId, null);
        await movieBroadcasterService.broadcastMovieList(io, roomId);
        io.to(roomId).emit('current-movie', { roomId, movieId: null });
        res.json({ success: true, removed });
      } catch (err) {
        console.error('[DELETE /movies] error:', err);
        res.status(500).json({ success: false, message: '清空播放列表失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/movies/:movieId - 删除影片（仅 root 或房间 owner）
  router.delete(
    '/:roomId/movies/:movieId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const movieId = Number(req.params.movieId);
        if (!Number.isFinite(movieId)) {
          res.status(400).json({ success: false, message: 'movieId 无效' });
          return;
        }

        const roomRepo = AppDataSource.getRepository(Room);
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可删除影片' });
          return;
        }

        const deleted = await movieService.deleteMovie(roomId, movieId);
        if (!deleted) {
          res.status(404).json({ success: false, message: '影片不存在' });
          return;
        }

        await movieBroadcasterService.broadcastMovieList(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('[DELETE /movies/:movieId] error:', err);
        res.status(500).json({ success: false, message: '删除影片失败' });
      }
    },
  );

  return router;
}
