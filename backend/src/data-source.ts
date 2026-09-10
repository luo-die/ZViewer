import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { QueryRunner } from 'typeorm';
import type { SqljsDriver } from 'typeorm/driver/sqljs/SqljsDriver';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';
import { PlaybackState } from './entities/PlaybackState';
import { ServerFolder } from './entities/ServerFolder';
import { DanmakuTrack } from './entities/DanmakuTrack';
import { RoomDanmakuMeta } from './entities/RoomDanmakuMeta';
import { AuditLog } from './entities/AuditLog';
import { DATABASE_PATH } from './services/paths';

export const AppDataSource = new DataSource({
  // sql.js（wasm）驱动：纯 JS 实现，无原生模块，单文件版可在任意平台运行
  type: 'sqljs',
  // 数据库文件统一存放在 config/ 目录下，便于升级时整体保留。
  // 路径解析详见 services/paths.ts（支持 DATABASE_URL 环境变量覆盖）。
  location: DATABASE_PATH,
  // 【性能 P0】关闭 TypeORM 的「每条写语句后自动落盘」：
  // sql.js 是「整库常驻内存 + 整库写回单文件」的驱动，autoSave:true 时
  // SqljsQueryRunner 在每条非 SELECT 语句结束的 flush() 中都会
  // export() 整个数据库并重写文件（见 node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js），
  // 弹幕/心跳/播放进度这类高频写入下写放大极严重（每秒多次整库拷贝 + 同步写盘）。
  // 现改为 1s 防抖落盘（scheduleSave + installDebouncedSave），
  // 需要立即落盘的关键路径显式调用 flushDatabase()。
  autoSave: false,
  useLocalForage: false,
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
  entities: [Room, Session, User, Comment, BilibiliCredential, Movie, UserMount, SystemSettings, PlaybackState, ServerFolder, DanmakuTrack, RoomDanmakuMeta, AuditLog],
  migrations: [],
  subscribers: [],
});

/** 防抖落盘间隔（毫秒）：窗口内的多次写入合并为一次整库导出 + 写文件 */
const SAVE_DEBOUNCE_MS = 1000;

let saveTimer: NodeJS.Timeout | null = null;
/** 是否正在写盘（避免两次并发重写同一个文件） */
let saving = false;
/** 写盘期间又有新变更：写完后再补一次 */
let saveAgain = false;

/**
 * 标记数据库已变更，1s 后合并落盘。
 *
 * 由 installDebouncedSave() 接管的 SqljsQueryRunner.flush() 调用：
 * TypeORM 保证每条非 SELECT 语句都会走到 flush()，因此不会漏写。
 */
export function scheduleSave(): void {
  if (saveTimer) return; // 当前窗口已有待落盘的变更，合并掉
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushDatabase();
  }, SAVE_DEBOUNCE_MS);
  // 定时器不应把进程钉住（否则退出时事件循环会等这个定时器）
  saveTimer.unref?.();
}

/**
 * 立即把内存数据库写回磁盘（防抖到期、关键写入、优雅退出均走这里）。
 *
 * @param force 忽略事务检查强制落盘（仅优雅退出使用：宁可写出当前镜像，也不能丢数据）
 */
export async function flushDatabase(force = false): Promise<void> {
  if (!AppDataSource.isInitialized) return; // 未初始化时没有内存库可写

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (saving) {
    saveAgain = true; // 上一次写盘未结束：标记补写
    return;
  }

  const driver = AppDataSource.driver as SqljsDriver;
  // sql.js 在事务进行中 export() 会终止当前事务（TypeORM 官方 autoSave 同样跳过），
  // 因此事务期间推迟到下个窗口重试，事务提交后 flush() 也会再次触发。
  if (!force && driver.queryRunner?.isTransactionActive) {
    scheduleSave();
    return;
  }

  saving = true;
  try {
    await driver.save();
  } catch (err) {
    console.error('[data-source] 数据库落盘失败:', err);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      scheduleSave();
    }
  }
}

/**
 * 安装防抖落盘（必须在 AppDataSource.initialize() 之后调用一次）。
 *
 * sql.js 只有一个 QueryRunner 实例（SqljsDriver.createQueryRunner() 始终返回同一个），
 * 因此把该实例的 flush() 从「导出整库 + 重写文件」换成「只标记脏」即可覆盖所有写路径，
 * 落盘统一交给 scheduleSave() 的 1s 防抖，最多每秒写一次整库。
 */
export function installDebouncedSave(): void {
  if (!AppDataSource.isInitialized) {
    console.error('[data-source] 数据源未初始化，防抖落盘未安装（自动落盘将失效）');
    return;
  }

  const queryRunner = AppDataSource.createQueryRunner() as QueryRunner & {
    flush?: () => Promise<void>;
    isDirty?: boolean;
  };
  if (typeof queryRunner.flush !== 'function') {
    // TypeORM 内部结构变化时这里会失效，必须显式告警：autoSave 已关闭，
    // 没有 flush 钩子就不会有任何自动落盘，只有关键路径的显式 flushDatabase()。
    console.error('[data-source] 未找到 SqljsQueryRunner.flush，防抖落盘未安装（TypeORM 版本变化？）');
    return;
  }

  // 闭包捕获唯一实例，等价于原实现里的 this
  queryRunner.flush = async () => {
    if (!queryRunner.isDirty) return; // 与原实现一致：只有发生过写语句才需要落盘
    queryRunner.isDirty = false; // 接管脏标记，落盘由下面的防抖定时器完成
    scheduleSave();
  };
}
