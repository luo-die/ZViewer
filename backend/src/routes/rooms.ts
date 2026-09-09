import { Router, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../data-source';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { DanmakuTrack } from '../entities/DanmakuTrack';
import { IsNull, In } from 'typeorm';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  danmakuMetaService,
  serializeDanmakuMeta,
} from '../modules/comment/danmaku-meta.service';

const roomRepository = () => AppDataSource.getRepository(Room);
const sessionRepository = () => AppDataSource.getRepository(Session);
const danmakuTrackRepository = () => AppDataSource.getRepository(DanmakuTrack);

function canControlRoom(req: AuthenticatedRequest, room: Room): boolean {
  const role = req.user?.role;
  if (role === 'root') return true;
  if (role === 'admin' && room.ownerUserId === req.user?.userId) return true;
  return false;
}

/** 弹幕轨道 DTO（与前端 DanmakuTrack 对齐） */
interface DanmakuTrackDto {
  trackId: string;
  label: string;
  source: string;
  items: unknown[];
  offset: number;
  hidden: boolean;
}

function serializeDanmakuTrack(track: DanmakuTrack): DanmakuTrackDto {
  let items: unknown[] = [];
  try {
    items = JSON.parse(track.items);
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
  return {
    trackId: track.trackId,
    label: track.label,
    source: track.source,
    items,
    offset: track.offset,
    hidden: track.hidden,
  };
}

async function broadcastDanmakuTracks(
  io: SocketIOServer,
  roomId: string,
): Promise<void> {
  const tracks = await danmakuTrackRepository().find({ where: { roomId } });
  io.to(roomId).emit('danmaku-tracks-updated', {
    roomId,
    tracks: tracks.map(serializeDanmakuTrack),
  });
}

export function createRoomsRouter(io: SocketIOServer): Router {
  const router = Router();

  router.use(authenticateToken);

  // GET /api/rooms - 获取房间列表
  router.get(
    '/',
    async (_req: AuthenticatedRequest, res: Response) => {
      try {
        const roomRepo = roomRepository();
        const sessionRepo = sessionRepository();
        const rooms = await roomRepo.find({
          where: { status: 'active' },
          order: { lastAccessedAt: 'DESC' },
        });

        // 批量查询观众数和 sharer 在线状态（消除 N+1）
        const roomIds = rooms.map((r) => r.roomId);
        const [allViewers, allSharers] = await Promise.all([
          sessionRepo.find({
            where: { roomId: In(roomIds), role: 'viewer', endedAt: IsNull() },
            select: ['roomId', 'socketId'],
          }),
          sessionRepo.find({
            where: { roomId: In(roomIds), role: 'sharer', endedAt: IsNull() },
            select: ['roomId', 'socketId'],
          }),
        ]);
        // 只统计 socket 仍在线会话：DB 里的「活跃」标记可能滞后（服务器重启
        // 残留、异常断线），否则房间列表会显示虚高的人数
        const viewerCountMap = new Map<string, number>();
        for (const v of allViewers) {
          if (!io.sockets.sockets.has(v.socketId)) continue;
          viewerCountMap.set(v.roomId, (viewerCountMap.get(v.roomId) || 0) + 1);
        }
        const sharerSet = new Set(
          allSharers
            .filter((s) => io.sockets.sockets.has(s.socketId))
            .map((s) => s.roomId),
        );

        const result = rooms.map((room) => ({
              id: room.id,
              roomId: room.roomId,
              name: room.name,
              status: room.status,
              requireApproval: room.requireApproval,
              maxViewers: room.maxViewers,
              hasPassword: !!room.password,
              viewerCount: viewerCountMap.get(room.roomId) ?? 0,
              sharerOnline: sharerSet.has(room.roomId),
              mode: room.mode,
              lastAccessedAt: room.lastAccessedAt.toISOString(),
              createdAt: room.createdAt.toISOString(),
            }));

        res.json({ success: true, rooms: result });
      } catch (err) {
        console.error('get rooms error:', err);
        res.status(500).json({ success: false, message: '获取房间列表失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/name - 修改房间名称（仅 root 或房间创建者）
  router.put(
    '/:roomId/name',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const { name } = req.body as { name?: unknown };
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) {
          res.status(400).json({ success: false, message: '房间名称不能为空' });
          return;
        }

        const roomRepo = roomRepository();
        const room = await roomRepo.findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }

        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改房间名称' });
          return;
        }

        room.name = trimmed;
        await roomRepo.save(room);

        io.to(roomId).emit('room-name-updated', { roomId, name: trimmed });
        res.json({ success: true, room: { roomId, name: trimmed } });
      } catch (err) {
        console.error('update room name error:', err);
        res.status(500).json({ success: false, message: '修改房间名称失败' });
      }
    },
  );

  // 影片 CRUD 与重排序路由已迁移至 modules/movie/movie.routes.ts
  // （createMovieRouter，含代理模式 URL 重写与挂载凭证自动补全），
  // 此处不再注册，避免同一路径先匹配旧实现导致重写逻辑失效。

  // GET /api/rooms/:roomId/danmaku-tracks - 获取弹幕轨道列表
  router.get(
    '/:roomId/danmaku-tracks',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const tracks = await danmakuTrackRepository().find({ where: { roomId } });
        res.json({
          success: true,
          tracks: tracks.map(serializeDanmakuTrack),
        });
      } catch (err) {
        console.error('get danmaku tracks error:', err);
        res.status(500).json({ success: false, message: '获取弹幕轨道失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/danmaku-tracks - 添加或替换单个弹幕轨道（仅 root 或房间创建者）
  router.post(
    '/:roomId/danmaku-tracks',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可添加弹幕轨道' });
          return;
        }

        const { trackId, label, source, items, offset, hidden } = req.body as {
          trackId?: unknown;
          label?: unknown;
          source?: unknown;
          items?: unknown;
          offset?: unknown;
          hidden?: unknown;
        };

        if (
          typeof trackId !== 'string' ||
          !trackId.trim() ||
          typeof label !== 'string' ||
          !label.trim() ||
          typeof source !== 'string' ||
          !source.trim() ||
          !Array.isArray(items)
        ) {
          res.status(400).json({ success: false, message: 'trackId/label/source/items 为必填项' });
          return;
        }

        // upsert：按 (roomId, trackId) 唯一，避免重复调用 setDefaultTrack
        // 等场景导致同一 trackId 累积多条记录。
        let track = await danmakuTrackRepository().findOneBy({
          roomId,
          trackId: trackId.trim(),
        });
        if (track) {
          track.label = label.trim();
          track.source = source.trim();
          track.items = JSON.stringify(items);
          track.offset =
            typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
          track.hidden = hidden === true;
        } else {
          track = danmakuTrackRepository().create({
            trackId: trackId.trim(),
            roomId,
            label: label.trim(),
            source: source.trim(),
            items: JSON.stringify(items),
            offset:
              typeof offset === 'number' && Number.isFinite(offset) ? offset : 0,
            hidden: hidden === true,
          });
        }
        await danmakuTrackRepository().save(track);
        await broadcastDanmakuTracks(io, roomId);
        res.status(201).json({ success: true, track: serializeDanmakuTrack(track) });
      } catch (err) {
        console.error('create danmaku track error:', err);
        res.status(500).json({ success: false, message: '添加弹幕轨道失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/danmaku-tracks/:trackId/offset - 修改弹幕轨道偏移（仅 root 或房间创建者）
  router.put(
    '/:roomId/danmaku-tracks/:trackId/offset',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const trackId = req.params.trackId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕轨道' });
          return;
        }

        const { offset, hidden } = req.body as { offset?: unknown; hidden?: unknown };
        const track = await danmakuTrackRepository().findOneBy({ roomId, trackId });
        if (!track) {
          res.status(404).json({ success: false, message: '弹幕轨道不存在' });
          return;
        }

        if (typeof offset === 'number' && Number.isFinite(offset)) {
          track.offset = offset;
        }
        if (typeof hidden === 'boolean') {
          track.hidden = hidden;
        }
        await danmakuTrackRepository().save(track);
        await broadcastDanmakuTracks(io, roomId);
        res.json({ success: true, track: serializeDanmakuTrack(track) });
      } catch (err) {
        console.error('update danmaku track offset error:', err);
        res.status(500).json({ success: false, message: '修改弹幕轨道失败' });
      }
    },
  );

  // DELETE /api/rooms/:roomId/danmaku-tracks/:trackId - 删除弹幕轨道（仅 root 或房间创建者）
  router.delete(
    '/:roomId/danmaku-tracks/:trackId',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const trackId = req.params.trackId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可删除弹幕轨道' });
          return;
        }

        // 批量删除所有匹配 (roomId, trackId) 的记录，
        // 避免历史累积的重复 trackId 残留。
        await danmakuTrackRepository().delete({ roomId, trackId });
        await broadcastDanmakuTracks(io, roomId);
        res.json({ success: true });
      } catch (err) {
        console.error('delete danmaku track error:', err);
        res.status(500).json({ success: false, message: '删除弹幕轨道失败' });
      }
    },
  );

  // POST /api/rooms/:roomId/danmaku-tracks/bulk - 批量替换弹幕轨道（仅 root 或房间创建者）
  router.post(
    '/:roomId/danmaku-tracks/bulk',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕轨道' });
          return;
        }

        const { tracks } = req.body as { tracks?: unknown };
        if (!Array.isArray(tracks)) {
          res.status(400).json({ success: false, message: 'tracks 必须是数组' });
          return;
        }

        await AppDataSource.transaction(async (manager) => {
          await manager.delete(DanmakuTrack, { roomId });
          for (const t of tracks) {
            const raw = t as Record<string, unknown>;
            if (
              typeof raw.trackId !== 'string' ||
              !raw.trackId.trim() ||
              typeof raw.label !== 'string' ||
              !raw.label.trim() ||
              typeof raw.source !== 'string' ||
              !raw.source.trim() ||
              !Array.isArray(raw.items)
            ) {
              continue;
            }
            const entity = manager.create(DanmakuTrack, {
              trackId: raw.trackId.trim(),
              roomId,
              label: raw.label.trim(),
              source: raw.source.trim(),
              items: JSON.stringify(raw.items),
              offset:
                typeof raw.offset === 'number' && Number.isFinite(raw.offset)
                  ? raw.offset
                  : 0,
              hidden: raw.hidden === true,
            });
            await manager.save(entity);
          }
        });

        await broadcastDanmakuTracks(io, roomId);
        const saved = await danmakuTrackRepository().find({ where: { roomId } });
        res.json({ success: true, tracks: saved.map(serializeDanmakuTrack) });
      } catch (err) {
        console.error('bulk replace danmaku tracks error:', err);
        res.status(500).json({ success: false, message: '批量替换弹幕轨道失败' });
      }
    },
  );

  // GET /api/rooms/:roomId/danmaku-meta - 获取房间弹幕辅助数据（屏蔽词/已删除/实时弹幕记录）
  router.get(
    '/:roomId/danmaku-meta',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const meta = await danmakuMetaService.getOrCreate(roomId);
        res.json({ success: true, meta: serializeDanmakuMeta(meta) });
      } catch (err) {
        console.error('get danmaku meta error:', err);
        res.status(500).json({ success: false, message: '获取弹幕辅助数据失败' });
      }
    },
  );

  // PUT /api/rooms/:roomId/danmaku-meta - 整体替换屏蔽词和已删除弹幕（仅 root 或房间创建者）
  // 注意：realtimeLog 由 send-danmaku 事件持久化，此接口不修改 realtimeLog
  router.put(
    '/:roomId/danmaku-meta',
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const roomId = req.params.roomId as string;
        const room = await roomRepository().findOneBy({ roomId });
        if (!room) {
          res.status(404).json({ success: false, message: '房间不存在' });
          return;
        }
        if (!canControlRoom(req, room)) {
          res.status(403).json({ success: false, message: '无权限：仅 root 或房间创建者可修改弹幕辅助数据' });
          return;
        }

        const { blockKeywords, deletedLog } = req.body as {
          blockKeywords?: unknown;
          deletedLog?: unknown;
        };

        // 未提供的字段从已有记录读取，保持原值
        const existing = await danmakuMetaService.getOrCreate(roomId);
        const existingDto = serializeDanmakuMeta(existing);
        const nextKeywords = Array.isArray(blockKeywords)
          ? blockKeywords.filter(
              (k): k is string => typeof k === 'string' && k.trim().length > 0,
            )
          : existingDto.blockKeywords;
        const nextDeleted = Array.isArray(deletedLog) ? deletedLog : existingDto.deletedLog;

        const meta = await danmakuMetaService.replaceBlockAndDeleted(
          roomId,
          nextKeywords,
          nextDeleted,
        );
        await danmakuMetaService.broadcast(io, roomId);
        res.json({ success: true, meta: serializeDanmakuMeta(meta) });
      } catch (err) {
        console.error('update danmaku meta error:', err);
        res.status(500).json({ success: false, message: '更新弹幕辅助数据失败' });
      }
    },
  );

  return router;
}
