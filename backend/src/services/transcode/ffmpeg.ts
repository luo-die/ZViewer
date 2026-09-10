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
