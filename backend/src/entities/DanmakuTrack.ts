import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 房间弹幕轨道持久化实体。
 *
 * 每条记录对应一个弹幕源（如 B站某集弹幕），包含原始弹幕内容、
 * 时间偏移、显示隐藏状态等。房主添加/修改后同步给房间内所有成员。
 */
@Entity()
// 索引（synchronize 会自动建索引）：轨道始终按 roomId 查询/删除，
// 无索引时每次读写弹幕轨道都要全表扫描（items 字段可达数 MB，代价很高）。
@Index(['roomId'])
export class DanmakuTrack {
  @PrimaryGeneratedColumn()
  id!: number;

  /** 前端生成的轨道唯一标识（如 bilibili-video:12345） */
  @Column({ type: 'varchar' })
  trackId!: string;

  /** 所属房间 ID */
  @Column({ type: 'varchar' })
  roomId!: string;

  /** 轨道显示名称 */
  @Column({ type: 'varchar' })
  label!: string;

  /** 弹幕源类型，JSON 序列化存储 */
  @Column({ type: 'text' })
  source!: string;

  /** 弹幕条目数组，JSON 序列化存储（可能较大，sqljs 不支持 longtext，统一用 text） */
  @Column({ type: 'text' })
  items!: string;

  /** 时间偏移（秒） */
  @Column({ type: 'double', default: 0 })
  offset!: number;

  /** 是否暂时隐藏 */
  @Column({ type: 'boolean', default: false })
  hidden!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
