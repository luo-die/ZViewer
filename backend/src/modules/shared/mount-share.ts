/**
 * 个人挂载共享（UserMount sharing）。
 *
 * 设计要点：
 * - 挂载归创建者（UserMount.userId）所有，创建者可通过 shareEnabled +
 *   shareScope/sharedUserIds 授权其他用户「使用」该挂载；
 * - 被共享者只能浏览目录、在自己有权限的房间中用该挂载添加影片——
 *   服务器地址/账号/密码一律不下发（toSharedMountDto 剥除）；
 * - 被共享者无权选择播放方式：直链/中转一律跟随挂载主的 directLink 设置
 *   （见 canUseDirectLink），后端不接受请求体覆盖。
 *
 * 本模块被 5 个挂载路由（webdav/openlist/ftp/emby/jellyfin）、共享路由
 * （/api/mounts）、以及影片创建接口共同复用。
 */
import { AppDataSource } from '../../data-source';
import { UserMount, type MountType } from '../../entities/UserMount';
import { User } from '../../entities/User';

/** 全部挂载类型（顺序与前端下拉一致） */
export const MOUNT_TYPES: MountType[] = [
  'webdav',
  'ftp',
  'openlist',
  'emby',
  'jellyfin',
];

/** 共享范围 */
export type ShareScope = 'selected' | 'all';

/** 下发给「被共享者」的挂载视图：不含任何连接信息 */
export interface SharedMountDto {
  id: number;
  type: MountType;
  name: string;
  /** 挂载主人（展示用，不含联系方式） */
  ownerUserId: number;
  ownerName: string | null;
  /**
   * 播放方式，与挂载主的设置保持一致（被共享者无权更改）：
   * true=直链直连（挂载主自己选了直链），false=服务器中转。
   */
  directLink: boolean;
  /** 恒为 true：前端据此区分「我的挂载」与「他人共享」 */
  shared: true;
  createdAt: string;
  updatedAt: string;
}

/** 自己挂载的视图：剥除密码，共享字段以数组形式下发 */
export interface OwnMountDto extends Omit<UserMount, 'password' | 'sharedUserIds'> {
  sharedUserIds: number[];
}

/** 解析 UserMount.sharedUserIds（JSON 数组）为数字数组，异常时返回空数组。 */
export function parseSharedUserIds(mount: UserMount): number[] {
  const raw = mount.sharedUserIds;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0);
  } catch {
    return [];
  }
}

/**
 * 判断某用户是否被授权使用该挂载（不含挂载主本人）。
 *
 * 附加约束：guest（userId <= 0）永远不可用——房间外的游客没有稳定身份，
 * 共享只面向已登录用户。
 */
export function isSharedWithUser(mount: UserMount, userId: number): boolean {
  if (!mount.shareEnabled) return false;
  if (userId <= 0) return false;
  if (mount.userId === userId) return false;
  if (mount.shareScope === 'all') return true;
  return parseSharedUserIds(mount).includes(userId);
}

/** 自己挂载的响应 DTO：剥除密码，sharedUserIds 转数组。 */
export function toOwnMountDto(mount: UserMount): OwnMountDto {
  const { password: _password, sharedUserIds, ...rest } = mount;
  return { ...rest, sharedUserIds: parseSharedUserIds(mount) } as OwnMountDto;
}

/** 被共享者视角的 DTO：只保留展示与使用所需的非敏感字段。 */
export function toSharedMountDto(
  mount: UserMount,
  ownerName: string | null,
): SharedMountDto {
  return {
    id: mount.id,
    type: mount.type,
    name: mount.name,
    ownerUserId: mount.userId,
    ownerName,
    // 播放方式同步挂载主设置：被共享者不参与选择
    directLink: mount.directLink === true,
    shared: true,
    createdAt: (mount.createdAt ?? new Date()).toISOString(),
    updatedAt: (mount.updatedAt ?? new Date()).toISOString(),
  };
}

/**
 * 查询共享给某用户的挂载（可限定类型）。
 *
 * sql.js 不支持按 JSON 数组字段过滤，因此取全部已开启共享的挂载后
 * 在内存中筛选——个人部署规模下挂载数量很小，代价可忽略。
 */
export async function findSharedMounts(
  userId: number,
  type?: MountType,
): Promise<UserMount[]> {
  if (userId <= 0) return [];
  const repo = AppDataSource.getRepository(UserMount);
  const candidates = await repo.find({
    where: type ? { shareEnabled: true, type } : { shareEnabled: true },
    order: { createdAt: 'DESC' },
  });
  return candidates.filter((m) => isSharedWithUser(m, userId));
}

/** 批量查询用户名（用于共享挂载列表展示挂载主）。 */
async function loadUsernames(userIds: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(userIds)].filter((id) => id > 0);
  const map = new Map<number, string>();
  if (unique.length === 0) return map;
  try {
    const users = await AppDataSource.getRepository(User).find({
      where: unique.map((id) => ({ id })),
      select: ['id', 'username'],
    });
    for (const u of users) map.set(u.id, u.username);
  } catch (err) {
    console.error('[mount-share] load owner names error:', err);
  }
  return map;
}

/** 查询共享给某用户的全部挂载 DTO（含挂载主用户名），按创建时间倒序。 */
export async function listSharedMountsFor(
  userId: number,
): Promise<SharedMountDto[]> {
  const mounts = await findSharedMounts(userId);
  if (mounts.length === 0) return [];
  const names = await loadUsernames(mounts.map((m) => m.userId));
  return mounts.map((m) => toSharedMountDto(m, names.get(m.userId) ?? null));
}

/**
 * 解析一次挂载访问：挂载主本人或（被授权的）被共享者均可访问。
 *
 * @returns mount + shared（是否以被共享者身份访问）；无权限返回 null
 */
export async function resolveAccessibleMount(
  mountId: number,
  type: MountType,
  userId: number,
): Promise<{ mount: UserMount; shared: boolean } | null> {
  const mount = await AppDataSource.getRepository(UserMount).findOneBy({
    id: mountId,
    type,
  });
  if (!mount) return null;
  if (mount.userId === userId) return { mount, shared: false };
  if (isSharedWithUser(mount, userId)) return { mount, shared: true };
  return null;
}

/**
 * 判断某次访问是否允许使用直链（直连源站）。
 *
 * - 挂载主：始终允许（沿用既有行为——直链/中转由添加影片时的开关决定）；
 * - 被共享者：无权选择，一律同步挂载主的 directLink 设置——
 *   挂载主用直链则该挂载对共享者也是直链，挂载主用中转则共享者只能中转。
 */
export function canUseDirectLink(mount: UserMount, shared: boolean): boolean {
  if (!shared) return true;
  return mount.directLink === true;
}

/** 共享设置更新请求体 */
export interface ShareSettingsInput {
  shareEnabled?: unknown;
  shareScope?: unknown;
  sharedUserIds?: unknown;
}

export interface NormalizedShareSettings {
  shareEnabled: boolean;
  shareScope: ShareScope;
  sharedUserIds: number[];
}

/**
 * 归一化共享设置请求体（非法值一律回退为安全默认值）。
 *
 * 目标用户列表仅接受正整数；null/undefined 表示保持原值（由调用方决定）。
 */
export function normalizeShareSettings(
  body: ShareSettingsInput,
): NormalizedShareSettings {
  const ids = Array.isArray(body.sharedUserIds)
    ? body.sharedUserIds
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    : [];
  return {
    shareEnabled: body.shareEnabled === true,
    shareScope: body.shareScope === 'all' ? 'all' : 'selected',
    sharedUserIds: [...new Set(ids)],
  };
}

/** 可选共享目标用户（供共享设置弹窗的用户选择器使用）。 */
export interface ShareTargetUser {
  id: number;
  username: string;
  role: string;
}

/**
 * 列出可作为共享目标的用户。
 *
 * 排除自己、游客（role=guest）与待审核用户（status=pending）；
 * 只下发 id/username/role，避免暴露其他账号信息。
 */
export async function listShareTargets(
  selfUserId: number,
): Promise<ShareTargetUser[]> {
  const users = await AppDataSource.getRepository(User).find({
    select: ['id', 'username', 'role', 'status'],
    order: { id: 'ASC' },
  });
  return users
    .filter(
      (u) =>
        u.id !== selfUserId && u.role !== 'guest' && u.status === 'active',
    )
    .map((u) => ({ id: u.id, username: u.username, role: u.role }));
}
