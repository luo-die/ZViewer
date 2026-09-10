/**
 * 播放状态定时广播服务（服务器心跳）。
 *
 * 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * 新架构：服务器每 2s 广播 sync-heartbeat（source: 'server'）+ 推算后的播放状态，
 *         房主断开后服务器继续广播，观众可继续观看。
 *
 * 核心逻辑：
 * - 每 2s 遍历所有有播放状态的房间
 * - 推算当前 currentTime（基于 lastUpdatedAt + isPlaying + playbackRate）
 * - 广播 sync-heartbeat 事件给房间所有成员
 * - 若房主在线，则跳过广播（房主自己会广播 watch-together-state）
 *   仅在房主断开期间接管广播
 *
 * 性能：
 * - 单个 setInterval，遍历内存缓存中的房间
 * - 每个房间仅一次 DB 读取（缓存命中时纯内存操作）
 */
import type { Server as SocketIOServer } from 'socket.io';
import { playbackMemoryService } from './playback-memory.service';

/** 服务器心跳广播间隔（毫秒） */
const SERVER_HEARTBEAT_INTERVAL_MS = 2000;

export class PlaybackBroadcasterService {
  private intervalId: NodeJS.Timeout | null = null;
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private io: SocketIOServer | null = null;

  /** 启动定时广播与缓存清理 */
  start(io: SocketIOServer): void {
    if (this.intervalId) {
      return; // 已启动
    }
    this.io = io;
    this.intervalId = setInterval(() => {
      void this.broadcastAll();
    }, SERVER_HEARTBEAT_INTERVAL_MS);

    // 每 30s 清理一次陈旧缓存（playback-memory + room-state）
    this.cleanupIntervalId = setInterval(() => {
      void playbackMemoryService.cleanupStaleCache();
      void import('../room/room-state.service').then(({ roomStateService }) => {
        roomStateService.cleanupStaleStates();
      }).catch((err) => {
        console.error('[cleanup] room-state 动态导入失败:', err);
      });
    }, 30000);
  }

  /** 停止定时广播与缓存清理 */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.io = null;
  }

  /**
   * 遍历所有有播放状态的房间，广播推算后的状态。
   */
  private async broadcastAll(): Promise<void> {
    if (!this.io) return;

    const roomIds = playbackMemoryService.getActiveRoomIds();
    for (const roomId of roomIds) {
      try {
        // 只在房主离线时由服务器接管广播
        if (playbackMemoryService.isHostOnline(roomId)) {
          continue;
        }

        // 检查房间是否有在线成员（socket），无观众时跳过广播
        const roomSockets = this.io.sockets.adapter.rooms.get(roomId);
        if (!roomSockets || roomSockets.size === 0) {
          continue;
        }

        const state = await playbackMemoryService.getAdvancedPlayback(roomId);
        if (!state) continue;

        // 统一心跳协议（#14）：只发 sync-heartbeat。
        // 前端（useServerHeartbeat / useViewerStateSync）只监听 sync-heartbeat——旧
        // server-heartbeat 一旦同时发出，同一份状态会被处理两遍（store 双写 + 渲染翻倍），
        // 故删除旧事件，仅保留 sync-heartbeat（source: 'server'）。
        this.io.to(roomId).emit('sync-heartbeat', {
          roomId,
          source: 'server',
          state,
        });
      } catch (err) {
        console.error(`[PlaybackBroadcaster] 广播房间 ${roomId} 失败:`, err);
      }
    }
  }
}

/** 全局单例 */
export const playbackBroadcasterService = new PlaybackBroadcasterService();
