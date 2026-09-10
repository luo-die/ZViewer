/**
 * ffmpeg 可执行文件探测（服务端转码的前置依赖）。
 *
 * 背景：iPhone Safari（iOS < 17.1）等老浏览器没有 MediaSource，
 * 无法运行浏览器端重封装/转码管线，只能由服务端 ffmpeg 转出 HLS 后播放。
 * 因此后端需要先确认「本机是否有可用的 ffmpeg」，再决定是否允许创建转码会话。
 *
 * 解析规则（与 services/paths.ts 的环境变量风格保持一致）：
 * 1. `FFMPEG_PATH` 环境变量优先——用户可指向自备的 ffmpeg（如 Windows 解压包、
 *    Docker 挂载进容器外的二进制）；必须能真正跑起来才会采用，否则回退到第 2 步。
 * 2. 其次尝试 PATH 中的 `ffmpeg`（Linux/macOS 包管理器安装、Windows 加入 PATH 的场景）。
 * 3. 都不行则返回 null，由路由层回 503 FFMPEG_MISSING 提示用户安装。
 *
 * 缓存策略：探测结果进程内缓存，避免每次请求都 fork 一个进程。
 * - 成功结果永久缓存（一次进程生命周期内 ffmpeg 不会凭空消失）；
 * - 失败结果只缓存 30 秒，用户装好 ffmpeg 后无需重启后端即可生效。
 *
 * 本文件刻意不依赖任何第三方库：只用 node:child_process。
 */
import { execFile } from 'node:child_process';

/** 探测命令超时：`ffmpeg -version` 正常 < 100ms，5s 足以覆盖冷启动/网络盘上的二进制。 */
const PROBE_TIMEOUT_MS = 5000;

/** 探测失败（未安装 ffmpeg）结果的缓存时长（毫秒）。 */
const NEGATIVE_CACHE_TTL_MS = 30 * 1000;

/** ffmpeg 版本行：`ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) ...` */
const VERSION_LINE_RE = /^ffmpeg version (\S+)/m;

/** 已解析出的 ffmpeg 路径（可执行命令或绝对路径），null 表示本机不可用。 */
let cachedPath: string | null = null;
/** 已解析出的 ffmpeg 版本号（从 `ffmpeg version X` 行取第一个字段）。 */
let cachedVersion: string | null = null;
/** 是否已完成过一次探测（失败结果需要靠它判断是否过了 TTL）。 */
let probed = false;
/** 上次探测完成的时间戳（毫秒）。 */
let probedAt = 0;
/** 正在进行的探测（并发请求共享同一个 Promise，避免同时 fork 多个进程）。 */
let inflight: Promise<string | null> | null = null;

/** 从 `ffmpeg -version` 输出中解析版本号；解析不到返回 null。 */
function parseVersion(output: string): string | null {
  const matched = VERSION_LINE_RE.exec(output);
  return matched ? matched[1] : null;
}

/**
 * 执行 `<cmd> -version` 并拿到 stdout。
 * 失败（命令不存在 / 无执行权限 / 超时）统一返回 null，不抛异常——
 * 「没有 ffmpeg」是正常业务分支，不该让调用方写 try/catch。
 */
function execVersion(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      ['-version'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      },
    );
  });
}

/**
 * 解析可用的 ffmpeg 路径（带缓存）。
 *
 * @returns ffmpeg 的命令名/路径；本机不可用时返回 null。
 */
export async function resolveFfmpegPath(): Promise<string | null> {
  if (probed) {
    if (cachedPath) return cachedPath;
    // 失败结果短期缓存：允许用户「装完 ffmpeg 不重启后端」
    if (Date.now() - probedAt < NEGATIVE_CACHE_TTL_MS) return null;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<string | null> => {
    // 1. FFMPEG_PATH 环境变量优先（但必须验证能跑）
    const envPath = (process.env.FFMPEG_PATH || '').trim();
    if (envPath) {
      const output = await execVersion(envPath);
      if (output) {
        cachedVersion = parseVersion(output);
        return envPath;
      }
      console.warn(
        `[transcode] FFMPEG_PATH 指向的 ffmpeg 无法执行（${envPath}），回退到 PATH 中的 ffmpeg`,
      );
    }

    // 2. PATH 中的 ffmpeg
    const output = await execVersion('ffmpeg');
    if (output) {
      cachedVersion = parseVersion(output);
      return 'ffmpeg';
    }

    return null;
  })();

  try {
    const resolved = await inflight;
    cachedPath = resolved;
    probed = true;
    probedAt = Date.now();
    if (!resolved) {
      cachedVersion = null;
      console.warn(
        '[transcode] 未检测到可用的 ffmpeg，服务端转码不可用' +
          '（请安装 ffmpeg 或设置 FFMPEG_PATH 环境变量）',
      );
    } else {
      console.log(
        `[transcode] ffmpeg 可用：${resolved}${cachedVersion ? ` (${cachedVersion})` : ''}`,
      );
    }
    return resolved;
  } finally {
    inflight = null;
  }
}

/**
 * 获取 ffmpeg 版本号（用于 /capability 展示）。
 *
 * 先确保路径已探测（复用同一份缓存），必要时再跑一次 `-version` 单独解析版本行。
 *
 * @returns 如 `6.1.1-full_build-www.gyan.dev`；不可用或解析失败返回 null。
 */
export async function getFfmpegVersion(): Promise<string | null> {
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) return null;
  if (cachedVersion) return cachedVersion;

  const output = await execVersion(ffmpegPath);
  cachedVersion = output ? parseVersion(output) : null;
  return cachedVersion;
}

// ==================== 视频编码器探测（硬件加速） ====================

/**
 * H.264 编码器候选：**前面的优先**。
 *
 * 服务端转码是实时性场景（一边转一边播），硬件编码器能把 CPU 占用从
 * 「吃满数核」降到接近零，直接决定能不能边转边流畅播放。
 * 顺序：NVENC（N 卡）→ QSV（Intel 核显）→ AMF（A 卡）→ VideoToolbox（macOS）
 * → VAAPI（Linux 通用）→ libx264（纯 CPU 兜底，任何环境都有）。
 */
const ENCODER_CANDIDATES = [
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_videotoolbox',
  'h264_vaapi',
] as const;

export interface ResolvedVideoEncoder {
  /** ffmpeg 的 -c:v 取值 */
  encoder: string;
  /** 是否硬件编码器（false = libx264 纯 CPU） */
  hardware: boolean;
}

/** 已选定的编码器（进程内缓存：探测一次要跑一次编码测试，不该反复做） */
let cachedEncoder: ResolvedVideoEncoder | null = null;
let encoderInflight: Promise<ResolvedVideoEncoder> | null = null;

/** 跑一次极小的测试编码：能被列出但实际不可用（无驱动/无设备）的编码器会在这里失败 */
function testEncoder(cmd: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'testsrc=d=0.1:s=64x64:r=10',
        '-frames:v', '1',
        '-c:v', encoder,
        '-f', 'null',
        '-',
      ],
      { timeout: 15000, windowsHide: true, maxBuffer: 512 * 1024 },
      (err) => resolve(!err),
    );
  });
}

/**
 * 选择实际可用的视频编码器（优先硬件，带测试编码验证）。
 *
 * - `TRANSCODE_VIDEO_ENCODER` 环境变量可强制指定（如 `h264_nvenc`、`libx264`），
 *   指定值同样会做一次测试编码，失败则回退自动探测；
 * - 自动探测顺序见 ENCODER_CANDIDATES；
 * - VAAPI 在 Linux 上需要 `TRANSCODE_VAAPI_DEVICE`（默认 /dev/dri/renderD128），
 *   测试时用 `-vaapi_device` 挂上，真正编码时同样要挂。
 */
export async function resolveVideoEncoder(): Promise<ResolvedVideoEncoder> {
  if (cachedEncoder) return cachedEncoder;
  if (encoderInflight) return encoderInflight;

  encoderInflight = (async (): Promise<ResolvedVideoEncoder> => {
    const fallback: ResolvedVideoEncoder = { encoder: 'libx264', hardware: false };
    const ffmpegPath = await resolveFfmpegPath();
    if (!ffmpegPath) return fallback;

    const forced = (process.env.TRANSCODE_VIDEO_ENCODER || '').trim();
    if (forced) {
      const ok = await testEncoder(ffmpegPath, forced);
      if (ok) {
        console.log(`[transcode] 使用指定编码器：${forced}`);
        return { encoder: forced, hardware: forced !== 'libx264' };
      }
      console.warn(
        `[transcode] TRANSCODE_VIDEO_ENCODER=${forced} 不可用，回退自动探测`,
      );
    }

    for (const candidate of ENCODER_CANDIDATES) {
      // VAAPI 需要显式设备节点，测试与编码都依赖它
      if (candidate === 'h264_vaapi' && process.platform === 'win32') continue;
      const ok = await testEncoder(ffmpegPath, candidate);
      if (ok) {
        console.log(`[transcode] 检测到硬件编码器：${candidate}（转码将走 GPU）`);
        return { encoder: candidate, hardware: true };
      }
    }

    console.log('[transcode] 未检测到可用硬件编码器，使用 libx264（CPU）');
    return fallback;
  })();

  try {
    cachedEncoder = await encoderInflight;
    return cachedEncoder;
  } finally {
    encoderInflight = null;
  }
}

/** 已探测到的编码器（同步读取；未探测时为 null） */
export function getCachedVideoEncoder(): ResolvedVideoEncoder | null {
  return cachedEncoder;
}
