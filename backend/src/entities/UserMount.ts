import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type MountType = 'webdav' | 'ftp' | 'openlist' | 'emby' | 'jellyfin';

@Entity()
export class UserMount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column()
  userId!: number;

  @Column({ type: 'simple-enum', enum: ['webdav', 'ftp', 'openlist', 'emby', 'jellyfin'] })
  type!: MountType;

  @Column()
  name!: string;

  @Column({ type: 'varchar', nullable: true })
  serverUrl!: string | null;

  @Column({ type: 'integer', nullable: true })
  port!: number | null;

  @Column({ type: 'varchar', nullable: true })
  path!: string | null;

  @Column({ type: 'varchar', nullable: true })
  username!: string | null;

  @Column({ type: 'varchar', nullable: true })
  password!: string | null;

  @Column({ type: 'varchar', nullable: true })
  indexUrl!: string | null;

  /** Emby API Key（X-Emby-Token）；与 username/password 二选一 */
  @Column({ type: 'varchar', nullable: true })
  apiKey!: string | null;

  /** Emby 登录后缓存的用户 ID（运行时使用，可空） */
  @Column({ type: 'varchar', nullable: true })
  embyUserId!: string | null;

  @Column({ type: 'boolean', default: false })
  directLink!: boolean;

  /**
   * 源站 HTTPS 直连能力（配置期探测结果）。
   *
   * - true：源站 http 地址在 https:// 同端口上 TLS 握手可用（http/https
   *   双栈），direct-url 可将 http 直链升级为 https——浏览器直连不受
   *   混合内容限制，零服务器带宽；
   * - false：源站不支持 TLS，direct-url 保持 http 直链，播放时走服务器
   *   代理（https 页面下浏览器会把 http 升级到 https 后握手失败）；
   * - null：未探测（旧数据兼容）。direct-url 调用时惰性补探测并写回。
   *
   * 探测在挂载保存时异步触发，播放层不做运行时探测——确定性决策在配置期完成。
   */
  @Column({ type: 'boolean', nullable: true })
  httpsDirect!: boolean | null;

  /**
   * 是否允许把该挂载共享给其他用户使用。
   *
   * 共享后对方（被共享者）只能做两件事：
   * - 浏览该挂载的目录树，挑选影片；
   * - 在自己有权限管理的房间中用它添加影片。
   *
   * 服务器地址、账号、密码一律不下发给被共享者（见 toSharedMountDto）；
   * 播放方式（直链/中转）由本挂载的 directLink 决定，被共享者无权更改。
   */
  @Column({ type: 'boolean', default: false })
  shareEnabled!: boolean;

  /**
   * 共享范围：
   * - selected：仅 sharedUserIds 列表中的用户可用
   * - all：所有已登录用户（含之后新注册的用户）都可用
   */
  @Column({ type: 'simple-enum', enum: ['selected', 'all'], default: 'selected' })
  shareScope!: 'selected' | 'all';

  /**
   * 共享目标用户 ID 列表（JSON 数组，shareScope === 'selected' 时生效）。
   * 空数组表示不共享给任何人（避免误开 shareEnabled 即全员可见）。
   */
  @Column({ type: 'text', default: '[]' })
  sharedUserIds!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
