/**
 * 服务端 HLS 转码会话管理。
 *
 * 背景：iPhone Safari（iOS < 17.1）等没有 MediaSource 的浏览器无法运行
 * 浏览器端重封装/转码管线，只能由服务端 ffmpeg 把源流转成 HLS，
 * 再由 hls.js / Safari 原生 HLS 播放器播放（无需 MSE）。
 *
 * 会话模型：
 * - 一次「影片 + 模式 + 起点」对应一个会话（Map 按 sessionKey 去重），
 *   hls.js 反复请求 index.m3u8、或同一房间多人同时观看时不会重复拉起 ffmpeg；
 * - 输出目录 `<CONFIG_DIR>/transcode/<sessionId>/`，内含 `index.m3u8`、
 *   `init.mp4`、`seg00001.m4s` ...（fmp4 分片，URI 全部保持相对路径，由路由层改写为绝对地址）；
 * - ffmpeg 以 argv 数组方式 spawn（绝不拼 shell 字符串），避免 URL 中的
 *   `&`、`?`、空格等字符被 shell 解释；
 * - stderr 只保留最后若干行在内存中（诊断用），不落盘、不刷日志，避免大文件转码把日志撑爆。
 *
 * 生命周期：
 * - `createSession()` 创建/复用会话；
 * - 路由层每次访问播放列表/分片调用 `touchSession()` 续期；
 * - 模块内单个 2 分钟定时器（已 unref，不阻塞进程退出）回收 15 分钟无访问的会话，
 *   kill ffmpeg 并递归删除目录；
 * - 进程退出前调用 `disposeTranscodeSessions()`（内部即 `cleanupAll()`）清理全部会话。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_DIR } from '../paths';
import {
  resolveFfmpegPath,
  resolveVideoEncoder,
  type ResolvedVideoEncoder,
} from './ffmpeg';

/** 转码模式：remux = 视频流直接 copy 重封装；transcode = 真转码（优先硬件编码器）。 */
export type TranscodeMode = 'remux' | 'transcode';

/**
 * HLS 分片时长（秒）。
 *
 * 4s 是「起播快 / 边界等待短 / 请求数不过多」的折中：
 * 分片越长，追到转码边界时等待越久（要等下一个分片写完）；
 * 分片越短，请求数越多、开销越大。同时它也是 GOP 长度（关键帧对齐分片）。
 *
 * 用 `TRANSCODE_SEGMENT_SECONDS` 可覆盖：调小（2）起播更快、拖动更细，
 * 代价是分片请求数与关键帧变多；调大（6~10）省带宽但起播更慢。
 */
const DEFAULT_HLS_SEGMENT_SECONDS = 4;

/** 分片时长的合法范围（太小会请求爆炸，太大起播要等到天荒地老）。 */
const MIN_SEGMENT_SECONDS = 1;
const MAX_SEGMENT_SECONDS = 15;

let cachedSegmentSeconds: number | null = null;

/** 读取（并缓存）分片时长；非法值一律回落默认 4s。 */
export function getHlsSegmentSeconds(): number {
  if (cachedSegmentSeconds !== null) return cachedSegmentSeconds;
  const raw = Number(process.env.TRANSCODE_SEGMENT_SECONDS || '');
  cachedSegmentSeconds =
    Number.isFinite(raw) && raw >= MIN_SEGMENT_SECONDS && raw <= MAX_SEGMENT_SECONDS
      ? raw
      : DEFAULT_HLS_SEGMENT_SECONDS;
  return cachedSegmentSeconds;
}

export interface TranscodeSession {
  /** 会话 ID（16 位十六进制随机串，同时作为目录名与 URL 片段）。 */
  id: string;
  /** 去重键：`<movieId>:<mode>:<start>`，同键会话复用同一个 ffmpeg 进程。 */
  sessionKey: string;
  /** 会话输出目录（绝对路径）。 */
  dir: string;
  /** 播放列表绝对路径（`<dir>/index.m3u8`）。 */
  playlistPath: string;
  /** ffmpeg 子进程；已退出/启动失败时为 null。 */
  process: ChildProcess | null;
  mode: TranscodeMode;
  /** 相对源文件的起点（秒），0 表示从头开始。 */
  startTime: number;
  /** 创建时间戳（毫秒）。 */
  createdAt: number;
  /** 最近一次被访问的时间戳（毫秒），空闲回收依据。 */
  lastAccessAt: number;
  /** ffmpeg 进程是否已结束（无论成功失败）。 */
  finished: boolean;
  /** 是否失败（非 0 退出码 / spawn 错误）。服务端主动 kill 不算失败。 */
  failed: boolean;
  /** 最近的 ffmpeg stderr 行（最多 STDERR_TAIL_LINES 行），用于 502 时回显诊断信息。 */
  errorTail: string[];
  /** ffmpeg stderr 原始缓冲（仅保留尾部 STDERR_BUFFER_MAX 字节），用于按行提取 errorTail。 */
  stderrBuffer: string;
  /** 是否已被服务端主动停止（主动停止不算失败，避免误报错误日志）。 */
  stopped: boolean;
  /** 归属键（房间 ID）：同房间新建会话时用于回收旧会话。 */
  ownerKey?: string;
  /** 影片 ID（仅用于日志与诊断）。 */
  movieId?: number;
  /** 实际使用的视频编码器（remux 时为 `copy`）。 */
  encoder: string;
  /** 源帧率（GOP 对齐用；未知时按 25fps 估算）。 */
  fps: number;
  /** 实际启用的硬件解码 API（null = 软件解码）。 */
  hwaccel: string | null;
  /** 是否已因硬件解码初始化失败而降级为软件解码。 */
  hwaccelFellBack: boolean;
  /** 降级前首次失败的原因（诊断用）。 */
  hwaccelFallbackReason?: string;
}

export interface CreateSessionOptions {
  /** 已带鉴权 token 的源地址（本机 /api/<source>/stream 之类的 HTTP URL）。 */
  inputUrl: string;
  /** 转码模式，默认 remux。 */
  mode?: TranscodeMode;
  /** 起点（秒），> 0 时以 `-ss` 输入定位。 */
  startTime?: number;
  /** 去重键：调用方按「影片 + 起点」生成。 */
  sessionKey: string;
  /**
   * 归属键（房间 ID）。
   *
   * 同一房间新建会话时会**停掉该房间的其它会话**——否则「切影片 / 拖进度 /
   * 切回自动」后旧 ffmpeg 仍在全速转码，多个进程叠加直接把 CPU 吃满。
   */
  ownerKey?: string;
  /** 影片 ID（仅用于日志与诊断）。 */
  movieId?: number;
  /**
   * 源探测缓存键（稳定的源标识，形如 `movie:12`）。
   *
   * inputUrl 里带着每次现签的 token，不能直接当缓存键；给了这个键之后，
   * 同一部影片的模式判定与帧率探测只跑一次 ffprobe，重复起播/拖动不再重复探测。
   */
  probeKey?: string;
}

/** 转码输出根目录：与其它运行时数据一起放在 config/ 下，升级时整体保留。 */
const TRANSCODE_ROOT = path.join(CONFIG_DIR, 'transcode');

/**
 * 空闲回收阈值：5 分钟无任何分片/播放列表请求即回收。
 *
 * 播放中的客户端会持续请求播放列表（hls.js / Safari 原生 HLS 都会周期性
 * 刷新），因此 5 分钟没有任何请求 = 已经没人在看。旧值 15 分钟太长，
 * 期间 ffmpeg 仍在全速转码（无 -re，会尽快跑完整个文件），是「后台一堆
 * 转码进程」的主要来源。
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** 空闲扫描间隔：30 秒一次（unref，不影响进程退出）。 */
const CLEANUP_INTERVAL_MS = 30 * 1000;

/**
 * 同时运行的转码会话上限（安全阀）。
 *
 * 正常情况下一台服务器同时只服务少量房间；超过上限时停掉「最久未被访问」
 * 的会话，避免异常场景（多房间同播、客户端反复重建会话）把 CPU 打满。
 */
const MAX_CONCURRENT_SESSIONS = 4;

/** 诊断信息保留的 stderr 行数。 */
const STDERR_TAIL_LINES = 20;

/** stderr 原始缓冲上限（字节）：只需尾部诊断信息，避免长转码把内存吃满。 */
const STDERR_BUFFER_MAX = 8 * 1024;

/** 会话表：id → 会话。 */
const sessions = new Map<string, TranscodeSession>();
/** 去重表：sessionKey → id。 */
const sessionKeys = new Map<string, string>();
/** 空闲回收定时器（懒创建，首个会话建立时才启动）。 */
let cleanupTimer: NodeJS.Timeout | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 起点归一化：非法/负数一律按 0 处理。 */
function normalizeStartTime(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 硬件解码设置。
 *
 * - 默认为「跟随硬件编码器」：编码探测已经在这台机器上跑通过一次真实编码，
 *   说明对应驱动栈可用，因此解码大概率也能用（解码比编码更成熟）；
 * - `TRANSCODE_HWACCEL` 可显式指定（`auto` / `cuda` / `qsv` / `d3d11va` /
 *   `videotoolbox` / `vaapi`）或关闭（`none` / `off` / `0`）。
 *
 * 若硬件解码初始化失败导致 ffmpeg 立刻退出，会话会自动去掉该选项重试一次，
 * 并把该结果记为全局熔断（后续会话不再尝试），因此默认开启不会把转码彻底卡死。
 */
export interface HwAccelOption {
  /** ffmpeg 的 `-hwaccel` 取值。 */
  accel: string;
  /** `-hwaccel_device`（仅 VAAPI 需要）。 */
  device?: string;
}

/** 编码器 → 同一套驱动栈的解码 API。 */
const HWACCEL_BY_ENCODER: Record<string, string> = {
  h264_nvenc: 'cuda',
  h264_qsv: 'qsv',
  h264_amf: 'd3d11va',
  h264_videotoolbox: 'videotoolbox',
  h264_vaapi: 'vaapi',
};

/**
 * 全局熔断：某次硬件解码初始化失败后，后续会话直接用软件解码。
 *
 * 只按会话降级的话，每换一部影片都会先失败一次、白等几秒再重试，
 * 因此这里记住探测结果——同一台机器上驱动栈是固定的。
 */
let hwAccelDisabled = false;

/** 解析硬件解码设置：显式配置优先，否则跟随硬件编码器（软件编码 → 不启用）。 */
function resolveHwAccel(encoder: ResolvedVideoEncoder): HwAccelOption | null {
  if (hwAccelDisabled) return null;
  const raw = (process.env.TRANSCODE_HWACCEL || '').trim().toLowerCase();
  if (raw === 'none' || raw === 'off' || raw === '0' || raw === 'false') return null;
  const accel = raw || (encoder.hardware ? HWACCEL_BY_ENCODER[encoder.encoder] : undefined);
  if (!accel) return null;
  const device =
    accel === 'vaapi' ? process.env.TRANSCODE_VAAPI_DEVICE || '/dev/dri/renderD128' : undefined;
  return { accel, device };
}

/**
 * 是否是「硬件加速初始化失败」。
 *
 * 只在启动阶段（还没写出播放列表）且 stderr 命中相关关键字时降级重试，
 * 避免把「源本身有问题」的失败也当成硬件问题反复重试。
 */
function looksLikeHwAccelFailure(tail: string): boolean {
  return /hwaccel|hwaccel_device|hardware|vaapi|cuda|nvcuda|qsv|d3d11|videotoolbox|dxva|Device setup|No device|Cannot load|cuInit|Failed to create|Invalid device|not supported by the hardware/i.test(
    tail,
  );
}

/**
 * 拼装 ffmpeg 参数。
 *
 * 参数要点：
 * - `-ss` 放在 `-i` 之前 = 输入定位，配合解码器关键帧定位，比输出定位快得多；
 *   未加 `-copyts` 时输出时间戳会从 0 重新开始，正是 HLS 从头播放所需的行为。
 * - `-c:v copy`（remux）只换容器不重编码，几乎零 CPU；`transcode` 优先硬件
 *   编码器（NVENC/QSV/AMF/VideoToolbox/VAAPI），没有硬件时回退 libx264
 *   veryfast/crf23 保证实时性（服务端要一边转一边播，不能追求画质极限）。
 * - 音频一律转 AAC：DTS/AC3/EAC3/TrueHD 之类浏览器根本解不了，copy 出去等于没声音。
 * - `-max_muxing_queue_size 1024`：大码率源在 mux 阶段 packet 堆积，
 *   默认队列会导致 ffmpeg 直接报错中断。
 * - fmp4 分片：`-hls_segment_type fmp4` + 独立的 `init.mp4` 初始化分片。
 */
function buildArgs(params: {
  inputUrl: string;
  mode: TranscodeMode;
  startTime: number;
  dir: string;
  playlistPath: string;
  encoder: ResolvedVideoEncoder;
  /** 源帧率（把 GOP 对齐到分片长度；未知时按 25fps 估算） */
  fps: number;
  /** 硬件解码设置（null = 纯软件解码） */
  hwaccel: HwAccelOption | null;
}): string[] {
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-y'];

  // 输入定位：-ss 必须在 -i 之前
  if (params.startTime > 0) {
    args.push('-ss', String(params.startTime));
  }
  // 网络源（网盘/远端 NAS）抖动时自动重连：否则一次读失败就整场转码中断，
  // 表现是「播到某处永久卡住」
  args.push(
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  );
  // 硬件解码：把解码从 CPU 挪到 GPU（同样必须是 -i 之前的输入选项）。
  // 只在真转码时启用——copy 直通时解码本来就不发生，加了只会让 ffmpeg 报警告。
  if (params.hwaccel) {
    args.push('-hwaccel', params.hwaccel.accel);
    if (params.hwaccel.device) {
      args.push('-hwaccel_device', params.hwaccel.device);
    }
  }
  args.push('-i', params.inputUrl);

  if (params.mode === 'transcode') {
    pushVideoEncoderArgs(
      args,
      params.encoder,
      params.fps,
      getHlsSegmentSeconds(),
    );
  } else {
    args.push('-c:v', 'copy');
  }

  // 音频统一转 AAC（浏览器可解），双声道 192k
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  // 大源防 mux 队列溢出
  args.push('-max_muxing_queue_size', '1024');

  // HLS 输出：event 列表（只追加不删除，便于任意拖动已转出的部分）
  // - independent_segments：每个分片自带关键帧，可独立解码
  // - temp_file：分片先写临时名、写完再改名，客户端不会读到半个分片
  //   （转码边界最容易踩到，表现为偶发花屏/解码错误）
  args.push(
    '-f', 'hls',
    '-hls_time', String(getHlsSegmentSeconds()),
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(params.dir, 'seg%05d.m4s'),
    params.playlistPath,
  );

  return args;
}

/**
 * 追加视频编码参数（按编码器分派）。
 *
 * 关键调优点：
 * - **GOP 对齐分片**：关键帧间距 = 分片时长，ffmpeg 才能在分片边界切干净；
 *   否则每个分片都要等下一个关键帧，边界产出变慢、起播更晚；
 * - **实时优先**：转码是「边转边播」，编码器缓冲越少分片出现越早
 *   （libx264 的 zerolatency 关掉 lookahead/B 帧，牺牲一点压缩率换实时性）；
 * - **线程上限**：默认只用一半核心，避免转码把整机 CPU 吃满连 Web 服务都卡
 *   （`TRANSCODE_THREADS` 可覆盖）；
 * - 各硬件编码器的参数差异较大，分别给一套可用默认值。
 */
function pushVideoEncoderArgs(
  args: string[],
  encoder: ResolvedVideoEncoder,
  fps: number,
  segmentSeconds: number,
): void {
  const gop = Math.max(1, Math.round(fps * segmentSeconds));

  switch (encoder.encoder) {
    case 'h264_nvenc':
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-tune', 'll',
        '-rc', 'vbr',
        '-cq', '23',
        '-b:v', '0',
        '-pix_fmt', 'yuv420p',
        '-g', String(gop),
      );
      break;
    case 'h264_qsv':
      args.push(
        '-c:v', 'h264_qsv',
        '-preset', 'veryfast',
        '-global_quality', '23',
        '-pix_fmt', 'nv12',
        '-g', String(gop),
      );
      break;
    case 'h264_amf':
      args.push(
        '-c:v', 'h264_amf',
        '-quality', 'speed',
        '-rc', 'cqp',
        '-qp_i', '22',
        '-qp_p', '24',
        '-pix_fmt', 'yuv420p',
        '-g', String(gop),
      );
      break;
    case 'h264_videotoolbox':
      args.push(
        '-c:v', 'h264_videotoolbox',
        '-b:v', '4000k',
        '-pix_fmt', 'yuv420p',
        '-g', String(gop),
      );
      break;
    case 'h264_vaapi':
      args.push(
        '-vaapi_device',
        process.env.TRANSCODE_VAAPI_DEVICE || '/dev/dri/renderD128',
        // VAAPI 需要先把帧上传到显存
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi',
        '-qp', '23',
        '-g', String(gop),
      );
      break;
    default:
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-sc_threshold', '0',
        '-threads', String(defaultTranscodeThreads()),
      );
      break;
  }

  // 输出分辨率上限（可选）：4K 源降到 1080p 能显著减轻解码与带宽压力。
  // 用 TRANSCODE_MAX_HEIGHT 开启（如 1080），默认不缩放。
  // 注意 VAAPI 已经用 -vf 做过 hwupload，这里避免重复覆盖。
  const maxHeight = Number(process.env.TRANSCODE_MAX_HEIGHT || '');
  if (
    Number.isFinite(maxHeight) &&
    maxHeight >= 240 &&
    encoder.encoder !== 'h264_vaapi'
  ) {
    args.push('-vf', `scale=-2:'min(${maxHeight},ih)'`);
  }
}

/** 转码线程数：默认留一半核心给 Web 服务，可用 TRANSCODE_THREADS 覆盖 */
export function defaultTranscodeThreads(): number {
  const forced = Number(process.env.TRANSCODE_THREADS || '');
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  const cores = os.cpus()?.length ?? 4;
  return Math.max(2, Math.floor(cores / 2));
}

/**
 * 日志用 argv 文本：把 `token=xxx` 打码，避免把鉴权 token 写进日志。
 * 仅用于 console 输出，spawn 始终使用原始数组。
 */
function formatArgsForLog(args: string[]): string {
  return args
    .map((arg) => arg.replace(/([?&]token=)[^&\s]+/gi, '$1***'))
    .join(' ');
}

/** 把 stderr 片段追加到会话缓冲，并刷新最近若干行。 */
function appendStderr(session: TranscodeSession, chunk: string): void {
  const merged = session.stderrBuffer + chunk;
  session.stderrBuffer =
    merged.length > STDERR_BUFFER_MAX ? merged.slice(merged.length - STDERR_BUFFER_MAX) : merged;
  session.errorTail = session.stderrBuffer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES);
}

/** 结束 ffmpeg 进程（幂等）。SIGKILL 在 Windows 上等价于 TerminateProcess，可立即生效。 */
function killProcess(session: TranscodeSession): void {
  const child = session.process;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  session.stopped = true;
  try {
    child.kill('SIGKILL');
  } catch (err) {
    console.warn(
      `[transcode] 结束 ffmpeg 进程失败（会话 ${session.id}）：`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 等待子进程退出（最多 timeoutMs），用于删除目录前确认文件句柄已释放。 */
function waitForExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child) return Promise.resolve();
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once('close', finish);
    child.once('error', finish);
  });
}

/**
 * 递归删除目录（带重试）。
 * Windows 下刚被 kill 的 ffmpeg 可能仍持有分片文件句柄，删除会 EBUSY/EPERM，
 * 短暂等待后重试即可；最终失败只告警，不影响会话回收。
 */
async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.warn(
          `[transcode] 删除转码目录失败：${dir}`,
          err instanceof Error ? err.message : err,
        );
        return;
      }
      await sleep(200);
    }
  }
}

/** 懒启动空闲回收定时器（unref：不让定时器拖住进程退出）。 */
function ensureCleanupTimer(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupIdleSessions();
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

/** 回收所有空闲超时的会话。 */
async function cleanupIdleSessions(): Promise<void> {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastAccessAt < IDLE_TIMEOUT_MS) continue;
    console.log(
      `[transcode] 会话 ${session.id} 空闲超过 ${Math.round(IDLE_TIMEOUT_MS / 60000)} 分钟，回收`,
    );
    await stopSession(session.id);
  }
}

/** 查找可复用的会话（仍在运行，或已转完且产出了播放列表）。 */
function findReusableSession(sessionKey: string): TranscodeSession | null {
  const id = sessionKeys.get(sessionKey);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) {
    sessionKeys.delete(sessionKey);
    return null;
  }
  if (session.failed) return null;
  // 仍在运行 → 直接复用（避免重复拉起 ffmpeg 抢带宽/CPU）
  if (session.process !== null && !session.finished) return session;
  // 已正常结束且播放列表存在 → 整片已转完，无需重跑
  if (session.finished && !session.stopped && fs.existsSync(session.playlistPath)) return session;
  return null;
}

/**
 * 用 ffprobe 判断源视频轨能否安全直通（remux），否则必须真转码。
 *
 * 背景（线上问题：切了服务端转码，安卓依旧只有声音没画面）：
 * 旧实现由前端按 `movie.videoCodec` 猜模式，而挂载类片源（WebDAV/OpenList/
 * FTP/Emby…）这个字段常年为空 → 猜成 remux → **HEVC 原样透传**，
 * 安卓/旧 iOS 依然解不了视频轨，症状与不开转码时一模一样。
 *
 * 判定规则（服务端转码的语义就是「兼容模式」，宁可多花 CPU 也要能播）：
 * - `h264` + `yuv420p`（8bit）→ copy 直通：几乎所有设备都能硬解，零 CPU；
 * - 其余（hevc / av1 / vp9 / 10bit / mpeg4 / 探测失败）→ libx264 重编码。
 *
 * ffprobe 只读文件头，通常几十毫秒；结果按「源标识」缓存（见下方探测缓存）。
 */

/** 源视频轨探测结果（模式判定 + GOP 对齐用） */
interface VideoProbeResult {
  codec: string | null;
  pixFmt: string | null;
  /** 帧率（GOP = 帧率 × 分片时长，用于让关键帧落在分片边界上） */
  fps: number | null;
}

/**
 * 源探测缓存。
 *
 * 一次 ffprobe 就要把源「打开 + 读头」，对网盘/远端 NAS 源通常是最慢的一步
 * （几百毫秒到几秒）。而模式判定与帧率计算用的是同一份探测结果，因此这里
 * 按「源标识」缓存整份结果并合并并发调用，避免同一部影片被探测两三次。
 *
 * 缓存键刻意不用完整 inputUrl：内部地址里带着每次现签的 token，直接当键等于
 * 永远不命中。优先用调用方给的稳定键（probeKey，形如 `movie:12`），
 * 缺省时退化为「去掉 token 的 URL」。
 */
const probeCache = new Map<string, VideoProbeResult>();
const probeInflight = new Map<string, Promise<VideoProbeResult>>();

/** 探测缓存键：优先稳定的 probeKey，否则用去掉鉴权参数的 URL。 */
export function probeCacheKey(inputUrl: string, probeKey?: string): string {
  if (probeKey) return probeKey;
  return inputUrl.replace(/([?&]token=)[^&]*/gi, '$1');
}

/**
 * 带缓存的源探测（失败结果同样缓存，避免每次重试都再等一轮超时）。
 * 并发请求同一个源时共享同一次探测。
 */
async function probeVideo(inputUrl: string, probeKey?: string): Promise<VideoProbeResult> {
  const key = probeCacheKey(inputUrl, probeKey);
  const cached = probeCache.get(key);
  if (cached) return cached;
  const inflight = probeInflight.get(key);
  if (inflight) return inflight;

  const task = probeVideoCodec(inputUrl).then((result) => {
    probeCache.set(key, result);
    if (probeCache.size > 200) probeCache.clear();
    return result;
  });
  probeInflight.set(key, task);
  try {
    return await task;
  } finally {
    probeInflight.delete(key);
  }
}

async function decideModeForInput(
  inputUrl: string,
  probeKey?: string,
): Promise<TranscodeMode> {
  const result = await probeVideo(inputUrl, probeKey);
  // 探测不出信息时按「必须转码」处理：兼容优先，避免又回到 HEVC 直通的老坑
  const mode: TranscodeMode =
    result.codec === 'h264' && (!result.pixFmt || result.pixFmt === 'yuv420p')
      ? 'remux'
      : 'transcode';
  console.log(
    `[transcode] 源探测：codec=${result.codec ?? '-'} pix_fmt=${result.pixFmt ?? '-'} fps=${result.fps ?? '-'} → ${mode}`,
  );
  return mode;
}

/**
 * 源帧率（GOP 计算用）。
 *
 * 帧率只影响「关键帧多久一个」，取整到常用档位即可，无需精确；
 * 探测失败时按 25fps 估算（GOP 略长于分片也无妨，只是边界不如对齐时干净）。
 */
async function resolveSourceFps(inputUrl: string, probeKey?: string): Promise<number> {
  const result = await probeVideo(inputUrl, probeKey);
  return result.fps && result.fps > 1 && result.fps < 240 ? result.fps : 25;
}

/** 调 ffprobe 读取首条视频轨的 codec_name / pix_fmt / 帧率（失败返回空） */
async function probeVideoCodec(inputUrl: string): Promise<VideoProbeResult> {
  const empty: VideoProbeResult = { codec: null, pixFmt: null, fps: null };
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return empty;
  // ffprobe 与 ffmpeg 同目录（FFMPEG_PATH 指向 exe 时同样适用）
  const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  return await new Promise((resolve) => {
    let settled = false;
    const done = (value: VideoProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(
        ffprobePath,
        [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name,pix_fmt,avg_frame_rate,r_frame_rate',
          '-of', 'json',
          inputUrl,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
        if (out.length > 64 * 1024) out = out.slice(0, 64 * 1024);
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(empty);
      }, 8000);
      child.on('error', () => {
        clearTimeout(timer);
        done(empty);
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out) as {
            streams?: {
              codec_name?: string;
              pix_fmt?: string;
              avg_frame_rate?: string;
              r_frame_rate?: string;
            }[];
          };
          const stream = parsed.streams?.[0];
          done({
            codec: stream?.codec_name?.toLowerCase() ?? null,
            pixFmt: stream?.pix_fmt?.toLowerCase() ?? null,
            fps: parseFrameRate(stream?.avg_frame_rate) ?? parseFrameRate(stream?.r_frame_rate),
          });
        } catch {
          done(empty);
        }
      });
    } catch {
      done(empty);
    }
  });
}

/** 解析 ffprobe 的 `24000/1001` 形式帧率为数字；非法/为 0 时返回 null */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numRaw, denRaw] = value.split('/');
  const num = Number(numRaw);
  const den = denRaw === undefined ? 1 : Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) {
    return null;
  }
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

/**
 * 创建（或复用）一个 HLS 转码会话。
 *
 * @throws 当本机没有可用 ffmpeg 时抛出 message 为 `FFMPEG_MISSING` 的 Error。
 */
export async function createSession(opts: CreateSessionOptions): Promise<TranscodeSession> {
  // 显式指定则尊重；未指定 / 'auto' 时由 ffprobe 探测源编码决定
  // （源是 HEVC/AV1/10bit 必须真转码，否则安卓等设备仍只有声音没画面）
  const mode: TranscodeMode =
    opts.mode === 'transcode'
      ? 'transcode'
      : opts.mode === 'remux'
        ? 'remux'
        : await decideModeForInput(opts.inputUrl, opts.probeKey);
  const startTime = normalizeStartTime(opts.startTime);

  // 1. 复用：同一「影片 + 模式 + 起点」已有会话时直接返回
  const reused = findReusableSession(opts.sessionKey);
  if (reused) {
    reused.lastAccessAt = Date.now();
    console.log(
      `[transcode] 复用会话 ${reused.id}（${reused.mode}，起点 ${reused.startTime}s）`,
    );
    return reused;
  }

  // 2. 同 key 的历史会话已失败/无产物 → 先回收，避免目录与进程堆积
  const staleId = sessionKeys.get(opts.sessionKey);
  if (staleId) {
    await stopSession(staleId);
  }

  // 2.1 同房间的其它会话一律停掉。
  // 关键修复：切影片 / 拖进度 / 切回自动之后，旧 ffmpeg 仍在全速转码
  // （没有 -re，它会尽快把整个文件跑完），多个进程叠加直接把 CPU 吃满。
  if (opts.ownerKey) {
    for (const other of [...sessions.values()]) {
      if (other.ownerKey !== opts.ownerKey) continue;
      if (other.id === staleId) continue;
      console.log(
        `[transcode] 房间 ${opts.ownerKey} 新建会话，回收同房间旧会话 ${other.id}（影片 ${other.movieId ?? '-'}）`,
      );
      await stopSession(other.id);
    }
  }

  // 2.2 并发上限安全阀：超限时停掉「最久未被访问」的会话
  const running = [...sessions.values()].filter(
    (s) => s.process !== null && !s.finished && !s.stopped,
  );
  if (running.length >= MAX_CONCURRENT_SESSIONS) {
    running.sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    const victims = running.slice(0, running.length - MAX_CONCURRENT_SESSIONS + 1);
    for (const victim of victims) {
      console.warn(
        `[transcode] 并发已达上限 ${MAX_CONCURRENT_SESSIONS}，回收最久未访问的会话 ${victim.id}`,
      );
      await stopSession(victim.id);
    }
  }

  // 3. ffmpeg 必须可用（路由层已提前判断并返回 503，这里只是兜底）
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('FFMPEG_MISSING');
  }

  // 4. 选择视频编码器（转码模式下优先硬件编码；remux 用不到但探测结果会被缓存）
  const encoder: ResolvedVideoEncoder =
    mode === 'transcode'
      ? await resolveVideoEncoder()
      : { encoder: 'copy', hardware: false };
  const fps = mode === 'transcode' ? await resolveSourceFps(opts.inputUrl, opts.probeKey) : 25;

  // 5. 硬件解码（跟随硬件编码器，可用 TRANSCODE_HWACCEL 覆盖/关闭）
  const hwaccel: HwAccelOption | null = mode === 'transcode' ? resolveHwAccel(encoder) : null;

  // 6. 建立输出目录
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(TRANSCODE_ROOT, id);
  const playlistPath = path.join(dir, 'index.m3u8');
  await fsp.mkdir(dir, { recursive: true });

  const session: TranscodeSession = {
    id,
    sessionKey: opts.sessionKey,
    dir,
    playlistPath,
    process: null,
    mode,
    startTime,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    finished: false,
    failed: false,
    errorTail: [],
    stderrBuffer: '',
    stopped: false,
    ownerKey: opts.ownerKey,
    movieId: opts.movieId,
    encoder: mode === 'transcode' ? encoder.encoder : 'copy',
    fps,
    hwaccel: hwaccel?.accel ?? null,
    hwaccelFellBack: false,
  };

  /**
   * 启动（或降级重启）ffmpeg。
   *
   * `hwaccelArg` 为 null = 纯软件解码：硬件解码初始化失败时用它重试一次。
   */
  const startFfmpeg = (hwaccelArg: HwAccelOption | null): void => {
    const args = buildArgs({
      inputUrl: opts.inputUrl,
      mode,
      startTime,
      dir,
      playlistPath,
      encoder,
      fps,
      hwaccel: hwaccelArg,
    });
    if (mode === 'transcode') {
      console.log(
        `[transcode] 会话 ${id} 编码器=${encoder.encoder}` +
          `${encoder.hardware ? '（硬件）' : '（CPU）'} fps=${fps} ` +
          `分片=${getHlsSegmentSeconds()}s 硬件解码=${hwaccelArg?.accel ?? '关闭'}`,
      );
    }
    console.log(`[transcode] 会话 ${id} 启动：${formatArgsForLog(args)}`);
    const child = spawn(ffmpegPath, args, {
      // 不接 stdin（-nostdin 双保险）、不要 stdout、stderr 用管道收集诊断信息
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    session.process = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => appendStderr(session, chunk));

    // spawn 本身失败（路径失效、权限不足）会以 error 事件抛出，而不是 throw
    child.on('error', (err) => {
      session.finished = true;
      session.failed = true;
      session.process = null;
      appendStderr(session, `[spawn error] ${err.message}`);
      console.error(`[transcode] 会话 ${id} 启动 ffmpeg 失败：`, err.message);
    });

    child.on('close', (code, signal) => {
      session.finished = true;
      session.process = null;
      if (session.stopped) {
        // 服务端主动停止（空闲回收 / DELETE），不算失败
        return;
      }
      if (code === 0) {
        console.log(`[transcode] 会话 ${id} 转码完成（${session.mode}）`);
        return;
      }
      const tail =
        session.errorTail.length > 0 ? session.errorTail.join(' | ') : '无 stderr 输出';
      // 硬件解码初始化失败（驱动不支持该编码/设备忙）→ 去掉 -hwaccel 重试一次。
      // 只在「还没写出播放列表」的启动阶段降级，避免打断已经播起来的客户端。
      if (
        hwaccelArg &&
        !session.hwaccelFellBack &&
        !fs.existsSync(session.playlistPath) &&
        looksLikeHwAccelFailure(tail)
      ) {
        session.hwaccelFellBack = true;
        session.hwaccel = null;
        hwAccelDisabled = true;
        console.warn(
          `[transcode] 会话 ${id} 硬件解码（${hwaccelArg.accel}）初始化失败，` +
            `改用软件解码重试一次（后续会话也将只用软件解码；` +
            `如需强制开启请修正 TRANSCODE_HWACCEL）：${tail}`,
        );
        void restartWithSoftwareDecode(session, () => startFfmpeg(null), tail);
        return;
      }
      session.failed = true;
      if (session.hwaccelFallbackReason) {
        session.errorTail = [
          `[硬件解码已降级为软件解码，首次失败原因] ${session.hwaccelFallbackReason}`,
          ...session.errorTail,
        ];
      }
      console.error(
        `[transcode] 会话 ${id} ffmpeg 异常退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）：${tail}`,
      );
    });
  };

  startFfmpeg(hwaccel);

  sessions.set(id, session);
  sessionKeys.set(opts.sessionKey, id);
  ensureCleanupTimer();

  return session;
}

/**
 * 硬件解码降级重启：清掉半成品目录、把会话状态复位，再用软件解码重跑一次。
 *
 * 复用同一个会话对象（id / 目录 / sessionKey 全不变），客户端此时仍在轮询
 * `/index.m3u8`，因此用户侧只表现为「起播慢了几秒」，而不是直接报错。
 */
async function restartWithSoftwareDecode(
  session: TranscodeSession,
  restart: () => void,
  firstFailureTail: string,
): Promise<void> {
  try {
    // 保留首次失败信息，方便第二次仍失败时把真正原因带给用户
    session.hwaccelFallbackReason = truncateTailText(firstFailureTail, 300);
    await removeDirWithRetry(session.dir);
    await fsp.mkdir(session.dir, { recursive: true });
  } catch (err) {
    console.warn(`[transcode] 会话 ${session.id} 清理半成品失败（继续重试）：`, err);
  }
  if (session.stopped) return;
  session.finished = false;
  session.failed = false;
  session.errorTail = [];
  session.stderrBuffer = '';
  restart();
}

/** 截断文本（保留头部，用于把首次失败原因挂到最终错误里）。 */
function truncateTailText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 取会话（不存在/已回收返回 undefined）。 */
export function getSession(id: string): TranscodeSession | undefined {
  return sessions.get(id);
}

/** 续期：路由层每次成功访问播放列表/分片时调用。 */
export function touchSession(id: string): void {
  const session = sessions.get(id);
  if (session) session.lastAccessAt = Date.now();
}

/** 停止并删除会话（kill ffmpeg + 递归删除目录），返回是否确实存在该会话。 */
export async function stopSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;

  sessions.delete(id);
  if (sessionKeys.get(session.sessionKey) === id) {
    sessionKeys.delete(session.sessionKey);
  }

  const child = session.process;
  killProcess(session);
  await waitForExit(child, 2000);
  await removeDirWithRetry(session.dir);
  return true;
}

/**
 * 停止某个房间的全部转码会话（含已结束但目录仍在的）。
 *
 * 客户端在「切影片 / 切回自动 / 离开房间」时主动调用，避免旧 ffmpeg
 * 继续空转；服务端的同房间回收与空闲回收是兜底。
 */
export async function stopSessionsForRoom(roomKey: string): Promise<number> {
  const targets = [...sessions.values()].filter((s) => s.ownerKey === roomKey);
  for (const target of targets) {
    console.log(`[transcode] 主动回收房间 ${roomKey} 的会话 ${target.id}`);
    await stopSession(target.id);
  }
  return targets.length;
}

/** 当前会话概览（诊断用；供日志/接口查看是否有残留转码进程）。 */
export function listSessions(): {
  id: string;
  movieId?: number;
  ownerKey?: string;
  mode: TranscodeMode;
  running: boolean;
  finished: boolean;
  failed: boolean;
  idleMs: number;
  encoder: string;
  fps: number;
  hwaccel: string | null;
}[] {
  const now = Date.now();
  return [...sessions.values()].map((s) => ({
    id: s.id,
    movieId: s.movieId,
    ownerKey: s.ownerKey,
    mode: s.mode,
    running: s.process !== null && !s.finished && !s.stopped,
    finished: s.finished,
    failed: s.failed,
    idleMs: now - s.lastAccessAt,
    encoder: s.encoder,
    fps: s.fps,
    hwaccel: s.hwaccel,
  }));
}

/** 清理全部会话（进程退出时调用）。 */
export async function cleanupAll(): Promise<void> {
  const ids = [...sessions.keys()];
  if (ids.length === 0) return;
  for (const id of ids) {
    await stopSession(id);
  }
  sessions.clear();
  sessionKeys.clear();
  console.log(`[transcode] 已清理全部转码会话（${ids.length} 个）`);
}

/**
 * 模块 dispose 钩子：清掉定时器并回收全部会话。
 * 由后端 gracefulShutdown（index.ts）调用，保证退出时不留 ffmpeg 僵尸进程与残留目录。
 */
export async function disposeTranscodeSessions(): Promise<void> {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  await cleanupAll();
}
