/**
 * 服务端 MKV(Matroska) 字幕提取 —— 不依赖 ffmpeg、不依赖浏览器。
 *
 * 背景：UHD Media Server（Emby 兼容分支）不实现字幕端点，内嵌字幕只存在于
 * MKV 容器里；其自研 web 播放器是在浏览器里解容器取字幕。浏览器端解容器
 * 依赖 Range 请求与 CORS，且在部分服务端上会失败，因此这里做服务端版本：
 *   - 优先用 Range 请求只读「元素头 + 字幕块」，跳过视频负载（省带宽）
 *   - 服务端不支持 Range 时退化为顺序流式读取（边读边丢弃，仅保留字幕块）
 *   - 文本字幕（S_TEXT/ASS、SSA、UTF8、WEBVTT）可直接还原成完整字幕文件
 *
 * 解析范围：EBML 头 → Segment → Info(TimestampScale) → Tracks → Cluster
 * （SimpleBlock / BlockGroup.Block），其余元素按 size 跳过。
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_LANGUAGE = 0x22b59c;
const ID_NAME = 0x536e;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

/** Matroska TrackType.Subtitle */
const TRACK_TYPE_SUBTITLE = 0x11;

const MAX_HEADER_BYTES = 32 * 1024 * 1024; // 探测阶段最多读这么多字节
const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024; // 单轨字幕文本上限
// Range 模式下每次抓取的窗口大小：越大 HTTP 往返越少（解容器需遍历整个文件）
const CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * 「跳读」模式（Range 跳过视频负载）的窗口大小。
 * 顺序流要下载整个文件（940MB 的单集约 2 分钟），而字幕只占其中极小一段；
 * 跳读模式下解析器只按需取小块：解析到视频块就只推进指针（不下载），
 * 到下一个元素再抓一个小窗口。窗口越小省得越多，但请求数越多。
 * 64KB 是折中：每个视频块浪费 ≤64KB，25 分钟剧集约 300~600 个请求、~20MB。
 */
const SKIP_WINDOW_BYTES = (() => {
  const raw = Number(process.env.MKV_SKIP_WINDOW_KB ?? 64);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1024) : 64 * 1024;
})();

/**
 * 跳读模式的最小请求间隔。顺序流只发 1 个请求，不受限流影响；
 * 跳读模式请求数多，间隔太小会触发上游 429，太大又浪费时间。
 * 遇到 429 会自适应翻倍（见 HttpByteReader.onRateLimit）。
 */
const SKIP_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.MKV_SKIP_MIN_INTERVAL_MS ?? 30);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
})();

/** 跳读模式的请求预算：超过后自动降级为顺序流（从当前位置继续），避免请求风暴 */
const SKIP_MAX_REQUESTS = (() => {
  const raw = Number(process.env.MKV_SKIP_MAX_REQUESTS ?? 1500);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 1500;
})();

/** 小于该体积的文件直接用顺序流（1 个请求就够，跳读没有收益） */
const RANGE_SKIP_MIN_FILE_BYTES = 64 * 1024 * 1024;

/**
 * 自适应策略：先用顺序流跑一小段，量一下上游吞吐，再决定是否切跳读。
 * - 上游快（内网/NAS，整集 20s 内能读完）→ 继续顺序流：请求数最少、最稳；
 * - 上游慢（远程/跨网，整集要读几十秒到几分钟）→ 切跳读：只下载字幕附近的块。
 * 采样时长与切换阈值都可调，便于按部署环境调优。
 */
const SKIP_SAMPLE_MS = (() => {
  const raw = Number(process.env.MKV_SKIP_SAMPLE_MS ?? 1200);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1200;
})();
const SKIP_PROJECT_MS = (() => {
  const raw = Number(process.env.MKV_SKIP_PROJECT_MS ?? 15_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();
/** 采样阶段的字节上限：快链路上不必读满 1.2s（否则会白读几十 MB） */
const SKIP_SAMPLE_BYTES = (() => {
  const raw = Number(process.env.MKV_SKIP_SAMPLE_MB ?? 16);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1024 * 1024) : 16 * 1024 * 1024;
})();

/**
 * 上游（第三方媒体服务器，如 UHD Media Server）对同一来源有请求频率限制：
 * 密集 / 并发 Range 请求会返回 429「请求过于频繁」。因此这里：
 *   - 所有上游请求串行排队，两次请求之间保持最小间隔；
 *   - 429 / 5xx / 网络错误按指数退避重试（尊重 Retry-After）；
 *   - 整文件提取默认走「单次顺序流」（mode='stream'），只发 1 个请求，
 *     天然不受限流影响（Range 模式仅在探测文件头时使用）。
 */
const UPSTREAM_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.MKV_UPSTREAM_MIN_INTERVAL_MS ?? 120);
  return Number.isFinite(raw) && raw >= 0 ? raw : 120;
})();
const UPSTREAM_MAX_RETRIES = 4;
const UPSTREAM_BASE_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 上游请求闸门：同一时刻只放行一个请求，并保证两次请求间隔 ≥ 最小间隔。 */
let upstreamGate: Promise<void> = Promise.resolve();
let upstreamLastAt = 0;

async function withUpstreamSlot<T>(
  task: () => Promise<T>,
  minIntervalMs = UPSTREAM_MIN_INTERVAL_MS,
): Promise<T> {
  const prev = upstreamGate;
  let release!: () => void;
  upstreamGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const wait = upstreamLastAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    upstreamLastAt = Date.now();
    return await task();
  } finally {
    release();
  }
}

/** 上游请求的限流参数（跳读模式用更小的间隔，并在 429 时自适应放大） */
interface UpstreamGate {
  minIntervalMs: number;
  /** 收到 429 时调用，调用方负责放大间隔 */
  onRateLimit?: () => void;
}

/**
 * 带上限流退避的上游请求。返回 4xx（非 429/408）时原样交给调用方判断；
 * 429 / 5xx / 网络异常会退避重试，重试用尽后返回最后一次响应（或抛错）。
 */
async function fetchUpstream(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  gate?: UpstreamGate,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= UPSTREAM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await withUpstreamSlot(
        () => fetch(url, { headers, signal: controller.signal }),
        gate?.minIntervalMs,
      );
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      if (res.status === 429) gate?.onRateLimit?.();
      if (!retryable || attempt === UPSTREAM_MAX_RETRIES) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : UPSTREAM_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 400);
      console.warn(
        `[mkv-subtitles] 上游 HTTP ${res.status}（限流/异常），${Math.round(delay)}ms 后重试（${attempt + 1}/${UPSTREAM_MAX_RETRIES}）`,
      );
      await sleep(delay);
      continue;
    } catch (err) {
      lastErr = err;
      if (attempt === UPSTREAM_MAX_RETRIES) throw err;
      await sleep(UPSTREAM_BASE_DELAY_MS * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('MKV 读取失败：上游请求失败');
}

export interface MkvSubtitleTrackInfo {
  trackNumber: number;
  codecId: string;
  language?: string;
  name?: string;
  format: 'ass' | 'srt' | 'vtt';
  isText: boolean;
}

export interface MkvProbeResult {
  tracks: MkvSubtitleTrackInfo[];
  /** 服务端是否支持 Range 请求（诊断用） */
  rangeSupported: boolean;
  timestampScale: number;
  /** 文件总大小（0 = 未知）；提取阶段据此选择跳读 / 顺序流 */
  fileSize: number;
}

export interface MkvExtractResult {
  content: string;
  format: 'ass' | 'srt' | 'vtt';
  track: MkvSubtitleTrackInfo;
  rangeSupported: boolean;
  /**
   * 是否读到了文件末尾（提取完整）。
   * false = 中途中断（上游限流/网络错误），内容只是「已读到的部分」，
   * 调用方**不得**把它当作完整结果落盘缓存。
   */
  complete: boolean;
}

export interface MkvSourceOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * 'range'（默认）：按需 Range 抓取窗口，适合只读文件头的探测；
   * 'stream'：单次请求顺序读取整个文件（提取字幕用，避免大量 Range 请求触发限流）。
   */
  mode?: 'range' | 'stream';
  /** Range 模式每次抓取的窗口大小（默认 4MB；跳读模式传小窗口） */
  windowBytes?: number;
  /** 两次上游请求之间的最小间隔（默认 120ms；跳读模式可放宽到 30ms） */
  minIntervalMs?: number;
  /** 文件总大小提示（来自探测阶段的 Content-Range，用于决定跳读还是顺序流） */
  fileSizeHint?: number;
  /**
   * 顺序流模式的读取限速（字节/秒，0/未设置 = 不限速）。
   * 字幕提取要与播放同时进行，若全速拉取整集文件会挤占「服务器 → 媒体源」
   * 的带宽，导致起播卡顿。限速后字幕仍能在开头几秒内到达（顺序读取，
   * 前面的 cue 先到），后台慢慢补齐，播放不受影响。
   */
  maxBytesPerSec?: number;
}

function isTextCodec(codecId: string): boolean {
  return /^S_TEXT\/(ASS|SSA|UTF8|WEBVTT)$/i.test(codecId.trim());
}

function codecToFormat(codecId: string): 'ass' | 'srt' | 'vtt' {
  const c = codecId.trim().toUpperCase();
  if (c === 'S_TEXT/ASS' || c === 'S_TEXT/SSA') return 'ass';
  if (c === 'S_TEXT/WEBVTT') return 'vtt';
  return 'srt';
}

/** 前向字节读取器：Range 模式按需抓取窗口，顺序模式边读边丢 */
class HttpByteReader {
  private pos = 0;
  private buf: Buffer = Buffer.alloc(0);
  private bufStart = 0;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private streamDone = false;
  /** 顺序模式限速：已读字节数与起始时间（见 throttleStream） */
  private streamBytes = 0;
  private streamStartedAt = Date.now();
  /** 已发出的上游请求数（跳读模式的预算控制用） */
  private requests = 0;
  /** 收到 429 的次数：连续限流说明跳读策略在该上游不可行，应尽快降级 */
  private rateLimitHits = 0;
  /** 上游文件总大小（从 Content-Range/Content-Length 推断，未知为 0） */
  fileSize = 0;
  /** 当前最小请求间隔（429 时自适应放大） */
  private minIntervalMs: number;

  private constructor(
    readonly rangeSupported: boolean,
    private readonly opts: MkvSourceOptions,
    initial?: {
      buf: Buffer;
      streamReader: ReadableStreamDefaultReader<Uint8Array> | null;
      bufStart?: number;
      pos?: number;
      fileSize?: number;
    },
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? UPSTREAM_MIN_INTERVAL_MS;
    if (initial) {
      this.buf = initial.buf;
      this.bufStart = initial.bufStart ?? 0;
      this.streamReader = initial.streamReader;
      this.pos = initial.pos ?? 0;
      if (initial.fileSize) this.fileSize = initial.fileSize;
    }
  }
 
  /** 跳读模式：每个小窗口一次请求，间隔更短；429 时自适应放大 */
  private gate(): UpstreamGate {
    return {
      minIntervalMs: this.minIntervalMs,
      onRateLimit: () => {
        this.rateLimitHits++;
        const next = Math.min(Math.max(this.minIntervalMs * 2, 60), 1000);
        if (next !== this.minIntervalMs) {
          console.warn(
            `[mkv-subtitles] 上游限流（429），请求间隔 ${this.minIntervalMs}ms → ${next}ms`,
          );
          this.minIntervalMs = next;
        }
      },
    };
  }

  /** 从 Content-Range / Content-Length 解析文件总大小 */
  private static parseFileSize(res: Response): number {
    const cr = res.headers.get('content-range');
    const total = cr ? Number(cr.split('/').pop()) : NaN;
    if (Number.isFinite(total) && total > 0) return total;
    const cl = Number(res.headers.get('content-length'));
    return Number.isFinite(cl) && cl > 0 ? cl : 0;
  }

  static async open(opts: MkvSourceOptions): Promise<HttpByteReader> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // 顺序模式：不带 Range 的单次请求（整文件顺序读，不会触发上游限流）
    const sequential = opts.mode === 'stream';
    const windowBytes = opts.windowBytes ?? CHUNK_SIZE;
    const headers = sequential
      ? { ...(opts.headers ?? {}) }
      : { ...(opts.headers ?? {}), Range: `bytes=0-${windowBytes - 1}` };
    const gate: UpstreamGate = {
      minIntervalMs: opts.minIntervalMs ?? UPSTREAM_MIN_INTERVAL_MS,
    };
    const res = await fetchUpstream(opts.url, headers, timeoutMs, gate);
    const rangeSupported = !sequential && res.status === 206;
    if (!res.ok && res.status !== 206) {
      throw new Error(`MKV 读取失败: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error(`MKV 读取失败: HTTP ${res.status}`);
    // 把首个响应的 body 作为初始缓冲（两种模式都用得上）
    const reader = res.body.getReader();
    const first = await reader.read();
    const buf = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
    return new HttpByteReader(rangeSupported, opts, {
      buf,
      streamReader: rangeSupported ? null : reader,
      fileSize: HttpByteReader.parseFileSize(res),
    });
  }

  /**
   * 从指定字节偏移继续读取（用于跳读 → 顺序流的降级：
   * Range: bytes=offset- 让上游从该位置把剩余内容顺序吐出来，
   * 之后按普通顺序流处理，不再产生小请求）。
   */
  static async openAt(
    opts: MkvSourceOptions,
    offset: number,
    asSequential: boolean,
  ): Promise<HttpByteReader> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const res = await fetchUpstream(
      opts.url,
      { ...(opts.headers ?? {}), Range: `bytes=${offset}-` },
      timeoutMs,
      { minIntervalMs: opts.minIntervalMs ?? UPSTREAM_MIN_INTERVAL_MS },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`MKV 读取失败: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error(`MKV 读取失败: HTTP ${res.status}`);
    const streamReader = res.body.getReader();
    const first = await streamReader.read();
    const buf = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
    const rangeSupported = !asSequential && res.status === 206;
    return new HttpByteReader(rangeSupported, opts, {
      buf,
      streamReader: rangeSupported ? null : streamReader,
      bufStart: offset,
      pos: offset,
      fileSize: HttpByteReader.parseFileSize(res),
    });
  }

  get bytesRead(): number {
    return this.bufStart + this.buf.length;
  }

  private async fetchRange(start: number, length: number): Promise<Buffer> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    this.requests++;
    const res = await fetchUpstream(
      this.opts.url,
      {
        ...(this.opts.headers ?? {}),
        Range: `bytes=${start}-${start + length - 1}`,
      },
      timeoutMs,
      this.gate(),
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`MKV 读取失败: HTTP ${res.status}`);
    }
    if (!this.fileSize) this.fileSize = HttpByteReader.parseFileSize(res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** 已发出的上游请求数（跳读模式预算控制） */
  get requestCount(): number {
    return this.requests;
  }

  /** 上游 429 次数 */
  get rateLimitCount(): number {
    return this.rateLimitHits;
  }

  /** 是否已读到数据源末尾（判定提取是否完整） */
  get eof(): boolean {
    if (this.fileSize > 0) return this.pos >= this.fileSize - 1;
    return this.streamDone && this.buf.length === 0;
  }

  /** 确保 [offset, offset+need) 已在缓冲中 */
  private async ensure(offset: number, need: number): Promise<void> {
    if (offset >= this.bufStart && offset + need <= this.bufStart + this.buf.length) {
      return;
    }
    if (offset < this.bufStart) {
      throw new Error('MKV 解析需要回退读取，但当前数据源不支持（顺序模式）');
    }
    if (this.rangeSupported) {
      const start = offset;
      // 跳读模式用小窗口（见 SKIP_WINDOW_BYTES）：解析到视频块只推进指针，
      // 真正下载的只有字幕块附近的小块数据。
      const length = Math.max(need, this.opts.windowBytes ?? CHUNK_SIZE);
      this.buf = await this.fetchRange(start, length);
      this.bufStart = start;
      return;
    }
    // 顺序模式：从流里继续读，丢弃已消费的前缀，避免内存无限增长
    if (offset > this.bufStart) {
      const drop = offset - this.bufStart;
      if (drop <= this.buf.length) {
        this.buf = this.buf.subarray(drop);
        this.bufStart = offset;
      }
    }
    while (this.bufStart + this.buf.length < offset + need) {
      if (!this.streamReader || this.streamDone) {
        throw new Error('MKV 数据源已结束（顺序模式）');
      }
      const { value, done } = await this.streamReader.read();
      if (done) {
        this.streamDone = true;
        break;
      }
      if (value && value.length) {
        this.buf = this.buf.length ? Buffer.concat([this.buf, Buffer.from(value)]) : Buffer.from(value);
        await this.throttleStream(value.length);
      }
    }
    if (this.bufStart + this.buf.length < offset + need) {
      throw new Error('MKV 数据源提前结束');
    }
  }

  get position(): number {
    return this.pos;
  }

  async readExactly(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    await this.ensure(this.pos, n);
    const start = this.pos - this.bufStart;
    const out = this.buf.subarray(start, start + n);
    this.pos += n;
    return out;
  }

  async peek(n: number): Promise<Buffer> {
    await this.ensure(this.pos, n);
    const start = this.pos - this.bufStart;
    return this.buf.subarray(start, start + n);
  }

  /**
   * 前进 n 字节；Range 模式只挪指针（不下载），顺序模式从流里丢弃。
   * 顺序模式必须「边读边丢」而不是先缓存到目标位置——否则跳过视频块时
   * 会把整块视频负载读进内存（大文件下内存与拷贝开销都不可接受）。
   */
  async skip(n: number): Promise<void> {
    if (n <= 0) return;
    if (this.rangeSupported) {
      this.pos += n;
      return;
    }
    let remaining = n;
    while (remaining > 0) {
      if (this.buf.length > 0) {
        const take = Math.min(remaining, this.buf.length);
        this.buf = this.buf.subarray(take);
        this.bufStart += take;
        this.pos += take;
        remaining -= take;
        continue;
      }
      if (!this.streamReader || this.streamDone) {
        this.streamDone = true;
        break;
      }
      const { value, done } = await this.streamReader.read();
      if (done) {
        this.streamDone = true;
        break;
      }
      if (value && value.length) {
        this.buf = Buffer.from(value);
        await this.throttleStream(value.length);
      }
    }
    // 流提前结束时也把指针推到位（后续读取会命中 EOF 分支）
    this.pos += remaining;
  }

  /**
   * 顺序模式的读取限速：按已读字节数推算「应花费时间」，超前则休眠。
   * 只在 stream 模式生效（Range 模式本来只读少量数据）。
   */
  private async throttleStream(chunkBytes: number): Promise<void> {
    this.streamBytes += chunkBytes;
    const limit = this.opts.maxBytesPerSec ?? 0;
    if (!limit || limit <= 0) return;
    const elapsedMs = Date.now() - this.streamStartedAt;
    const expectedMs = (this.streamBytes / limit) * 1000;
    const waitMs = expectedMs - elapsedMs;
    if (waitMs > 20) await sleep(Math.min(waitMs, 1000));
  }

  async close(): Promise<void> {
    try {
      await this.streamReader?.cancel();
    } catch {
      /* ignore */
    }
  }
}

interface ElementHeader {
  id: number;
  size: number;
  /** size 是否未知（VINT 全 1） */
  unknownSize: boolean;
  headerLength: number;
}

async function readElementHeader(reader: HttpByteReader): Promise<ElementHeader> {
  const first = (await reader.peek(1))[0];
  if (first === undefined) throw new Error('MKV 元素头读取失败');
  let idLength = 1;
  if (first & 0x80) idLength = 1;
  else if (first & 0x40) idLength = 2;
  else if (first & 0x20) idLength = 3;
  else if (first & 0x10) idLength = 4;
  else throw new Error('MKV 元素 ID 非法');
  const idBuf = await reader.readExactly(idLength);
  let id = 0;
  for (const b of idBuf) id = id * 256 + b;

  const sizeFirst = (await reader.peek(1))[0];
  if (sizeFirst === undefined) throw new Error('MKV 元素长度读取失败');
  let sizeLength = 1;
  if (sizeFirst & 0x80) sizeLength = 1;
  else if (sizeFirst & 0x40) sizeLength = 2;
  else if (sizeFirst & 0x20) sizeLength = 3;
  else if (sizeFirst & 0x10) sizeLength = 4;
  else if (sizeFirst & 0x08) sizeLength = 5;
  else if (sizeFirst & 0x04) sizeLength = 6;
  else if (sizeFirst & 0x02) sizeLength = 7;
  else sizeLength = 8;
  const sizeBuf = await reader.readExactly(sizeLength);
  let size = BigInt(sizeBuf[0] & (0xff >> sizeLength));
  for (let i = 1; i < sizeLength; i++) size = (size << BigInt(8)) | BigInt(sizeBuf[i]);
  const allOnes = size === (BigInt(1) << BigInt(7 * sizeLength)) - BigInt(1);
  const sizeNumber = allOnes ? 0 : Number(size);
  return {
    id,
    size: sizeNumber,
    unknownSize: allOnes,
    headerLength: idLength + sizeLength,
  };
}

function readUint(buf: Buffer): number {
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

/** 读取 SimpleBlock / Block 负载开头的轨道号（VINT，通常 1 字节）；不足返回 -1 */
function peekBlockTrack(head: Buffer): number {
  if (head.length === 0) return -1;
  const first = head[0]!;
  let len = 1;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return -1;
  if (head.length < len) return -1;
  let track = first & (0xff >> len);
  for (let i = 1; i < len; i++) track = track * 256 + head[i]!;
  return track;
}

interface TrackEntry {
  trackNumber: number;
  trackType: number;
  codecId: string;
  codecPrivate?: Buffer;
  language?: string;
  name?: string;
}

async function parseTracks(reader: HttpByteReader, size: number): Promise<TrackEntry[]> {
  const end = reader.position + size;
  const entries: TrackEntry[] = [];
  let current: TrackEntry | null = null;
  while (reader.position < end) {
    const header = await readElementHeader(reader);
    const elemEnd = header.unknownSize ? end : reader.position + header.size;
    if (header.id === ID_TRACK_ENTRY) {
      if (current) entries.push(current);
      current = { trackNumber: 0, trackType: 0, codecId: '' };
      // 递归解析 TrackEntry 子元素
      while (reader.position < elemEnd) {
        const sub = await readElementHeader(reader);
        const subEnd = reader.position + sub.size;
        if (sub.id === ID_TRACK_NUMBER) {
          current.trackNumber = readUint(await reader.readExactly(sub.size));
        } else if (sub.id === ID_TRACK_TYPE) {
          current.trackType = readUint(await reader.readExactly(sub.size));
        } else if (sub.id === ID_CODEC_ID) {
          current.codecId = (await reader.readExactly(sub.size)).toString('utf8').replace(/\0+$/, '');
        } else if (sub.id === ID_CODEC_PRIVATE) {
          current.codecPrivate = Buffer.from(await reader.readExactly(sub.size));
        } else if (sub.id === ID_LANGUAGE) {
          current.language = (await reader.readExactly(sub.size)).toString('utf8').replace(/\0+$/, '');
        } else if (sub.id === ID_NAME) {
          current.name = (await reader.readExactly(sub.size)).toString('utf8').replace(/\0+$/, '');
        } else {
          await reader.skip(subEnd - reader.position);
        }
      }
    } else {
      await reader.skip(elemEnd - reader.position);
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** 探测容器里的文本字幕轨（只读到 Tracks 为止） */
export async function probeMkvSubtitleTracks(opts: MkvSourceOptions): Promise<MkvProbeResult> {
  const reader = await HttpByteReader.open(opts);
  try {
    let timestampScale = 1_000_000;
    let tracks: TrackEntry[] = [];
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    // EBML 头
    const ebml = await readElementHeader(reader);
    if (ebml.id !== ID_EBML) throw new Error('不是有效的 MKV 文件');
    await reader.skip(ebml.size);
    // Segment
    const segment = await readElementHeader(reader);
    if (segment.id !== ID_SEGMENT) throw new Error('未找到 MKV Segment');
    const segmentEnd = segment.unknownSize ? Number.POSITIVE_INFINITY : reader.position + segment.size;
    while (reader.position < segmentEnd && tracks.length === 0) {
      if (Date.now() > deadline) throw new Error('MKV 探测超时');
      if (reader.bytesRead > MAX_HEADER_BYTES) throw new Error('MKV 头部过大，未找到字幕轨');
      const header = await readElementHeader(reader);
      const elemEnd = reader.position + header.size;
      if (header.id === ID_INFO) {
        while (reader.position < elemEnd) {
          const sub = await readElementHeader(reader);
          if (sub.id === ID_TIMESTAMP_SCALE) {
            timestampScale = readUint(await reader.readExactly(sub.size)) || timestampScale;
          } else {
            await reader.skip(reader.position + sub.size - reader.position);
          }
        }
      } else if (header.id === ID_TRACKS) {
        tracks = await parseTracks(reader, header.size);
      } else {
        await reader.skip(elemEnd - reader.position);
      }
    }
    return {
      rangeSupported: reader.rangeSupported,
      timestampScale,
      fileSize: reader.fileSize,
      tracks: tracks
        .filter((t) => t.trackType === TRACK_TYPE_SUBTITLE)
        .map((t) => ({
          trackNumber: t.trackNumber,
          codecId: t.codecId,
          language: t.language,
          name: t.name,
          format: codecToFormat(t.codecId),
          isText: isTextCodec(t.codecId),
        })),
    };
  } finally {
    await reader.close();
  }
}

interface RawCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** ASS 时间格式：H:MM:SS.cc */
function formatAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Matroska 的 ASS 块负载是 9 字段：
 *   ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
 * （时间戳来自 Block，不在负载里）。直接拼进 [Events] 会字段错位、字幕不显示，
 * 因此这里重组成标准 10 字段 Dialogue 行——与前端 mkv-embedded 的处理一致。
 * 少数封装工具写的是完整 ASS 行（带 Dialogue:/Comment: 前缀），原样保留。
 */
function toAssDialogueLine(cue: RawCue): string {
  const raw = cue.text.trimEnd();
  if (!raw) return '';
  const prefixed = /^(Dialogue|Comment)\s*:/i.test(raw);
  const body = raw.replace(/^(Dialogue|Comment)\s*:\s*/i, '');
  const fields = body.split(',');
  const end = cue.endMs > cue.startMs ? cue.endMs : cue.startMs + 2000;
  if (prefixed && fields.length >= 10) return `Dialogue: ${body}`;
  if (fields.length >= 9) {
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(end)},${fields.slice(2).join(',')}`;
  }
  return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(end)},${body}`;
}

/** 从 ASS 块负载里取出纯文本（SRT/VTT 用） */
function assPayloadText(raw: string): string {
  const text = raw.trimEnd();
  if (!text) return '';
  const body = text.replace(/^(Dialogue|Comment)\s*:\s*/i, '');
  const fields = body.split(',');
  if (fields.length >= 10) return fields.slice(9).join(','); // 带 Start/End 的完整行
  if (fields.length >= 9) return fields.slice(8).join(','); // Matroska 9 字段
  return body;
}

/** 组装字幕文本（ASS/SRT/VTT）；提取过程中也用它产出「已提取部分」 */
function buildSubtitleContent(
  format: 'ass' | 'srt' | 'vtt',
  track: TrackEntry,
  cues: RawCue[],
): string {
  if (format === 'ass') {
    const header = (
      track.codecPrivate?.toString('utf8') ??
      '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1'
    )
      .replace(/\r\n/g, '\n')
      .replace(/\s+$/, '');
    const body = cues.map(toAssDialogueLine).filter(Boolean).join('\n');
    // codecPrivate 自带 [Events]（含 Comment 事件）且后面可能还有 [Fonts]/[Graphics] 段，
    // 因此字幕行必须追加在**新开的** [Events] 段里，否则会被解析器整体跳过
    return `${header}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${body}\n`;
  }
  if (format === 'vtt') {
    const lines: string[] = ['WEBVTT', ''];
    cues.forEach((c) => {
      const start = formatSrtTime(c.startMs).replace(',', '.');
      const end = formatSrtTime(c.endMs > c.startMs ? c.endMs : c.startMs + 2000).replace(',', '.');
      lines.push(`${start} --> ${end}`, assPayloadText(c.text), '');
    });
    return lines.join('\n');
  }
  // SRT：用块时间戳合成（若块没有时长，用下一块的起点兜底）
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  const lines: string[] = [];
  ordered.forEach((cue, i) => {
    const next = ordered[i + 1];
    const end = cue.endMs > cue.startMs ? cue.endMs : next ? next.startMs : cue.startMs + 2000;
    lines.push(String(i + 1), `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(end)}`, assPayloadText(cue.text), '');
  });
  return lines.join('\n');
}

function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(msPart).padStart(3, '0')}`;
}

/** 提取指定字幕轨的完整文本（ASS/SSA 直接拼装，SRT/VTT 用块时间戳合成） */
export async function extractMkvSubtitleTrack(
  opts: MkvSourceOptions,
  trackNumber: number,
  /** 提取过程中回调「已读到的部分字幕」（约每 5 秒一次，供前端渐进显示） */
  onPartial?: (content: string) => void,
): Promise<MkvExtractResult> {
  // 提取整轨必须遍历全部 Cluster，两种读取策略：
  // - 顺序流（1 个请求，下载整个文件）：请求数最少、最稳，但 940MB 的单集要读 1~2 分钟，
  //   且与播放抢带宽；
  // - 跳读（Range 小窗口 + 跳过视频负载）：只下载字幕附近的小块数据（~20MB 量级），
  //   完整字幕从分钟级降到十几秒，代价是请求数变多（需要限流保护）。
  // 策略：大文件走跳读，小文件/未知大小走顺序流；跳读请求数超预算时自动降级为
  // 「从当前位置继续的顺序流」，避免把上游限流额度打满。
  const skipOpts: MkvSourceOptions = {
    ...opts,
    mode: 'range',
    windowBytes: opts.windowBytes ?? SKIP_WINDOW_BYTES,
    minIntervalMs: opts.minIntervalMs ?? SKIP_MIN_INTERVAL_MS,
  };
  // mode='range' 强制跳读；mode='stream' 强制顺序流；未指定则自适应。
  const forceSkip = opts.mode === 'range';
  const forceStream = opts.mode === 'stream';
  let reader = await HttpByteReader.open(forceSkip ? skipOpts : { ...opts, mode: 'stream' });
  const streamStartedAt = Date.now();
  // 已完成策略决策（跳读 / 顺序流 / 不支持 Range）
  let strategyDecided = forceSkip || forceStream;
  try {
    let timestampScale = 1_000_000;
    let tracks: TrackEntry[] = [];
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);

    const ebml = await readElementHeader(reader);
    if (ebml.id !== ID_EBML) throw new Error('不是有效的 MKV 文件');
    await reader.skip(ebml.size);
    const segment = await readElementHeader(reader);
    if (segment.id !== ID_SEGMENT) throw new Error('未找到 MKV Segment');
    const segmentEnd = segment.unknownSize ? Number.POSITIVE_INFINITY : reader.position + segment.size;

    const cues: RawCue[] = [];
    let cuesBytes = 0;
    let sawCluster = false;
    let lastPartialAt = 0;
    /**
     * 边读边交付：整集要读 1~2 分钟，先让已读到的部分字幕立即可用。
     * 间隔取 1.2s：开头的 cue 几乎立刻可用，播放瞬间就有字幕；
     * 后续按同样节奏补齐，前端无需等待完整提取。
     */
    const PARTIAL_INTERVAL_MS = 1_200;
    const emitPartial = (): void => {
      if (!onPartial || cues.length === 0) return;
      const now = Date.now();
      if (now - lastPartialAt < PARTIAL_INTERVAL_MS) return;
      lastPartialAt = now;
      const entry = tracks.find((t) => t.trackNumber === trackNumber);
      if (!entry || !isTextCodec(entry.codecId)) return;
      try {
        onPartial(buildSubtitleContent(codecToFormat(entry.codecId), entry, cues));
      } catch {
        /* 部分结果失败不影响整体提取 */
      }
    };

    const parseBlockPayload = (payload: Buffer): { track: number; relative: number; text: string } | null => {
      if (payload.length < 4) return null;
      // track number vint（通常 1 字节）
      const first = payload[0];
      let trackLen = 1;
      if (first & 0x80) trackLen = 1;
      else if (first & 0x40) trackLen = 2;
      else if (first & 0x20) trackLen = 3;
      else if (first & 0x10) trackLen = 4;
      else return null;
      let track = first & (0xff >> trackLen);
      for (let i = 1; i < trackLen; i++) track = track * 256 + payload[i];
      if (payload.length < trackLen + 3) return null;
      const relative = payload.readInt16BE(trackLen);
      const flags = payload[trackLen + 2];
      const lacing = (flags >> 1) & 0x03;
      let textStart = trackLen + 3;
      if (lacing !== 0) {
        // 文本字幕极少使用 lacing；为稳妥起见按无 lacing 处理（取整个负载）
        textStart = trackLen + 3 + 1;
      }
      const text = payload.subarray(textStart).toString('utf8');
      return { track, relative, text };
    };

    // 解析循环整体包一层：Cluster 内部的读取错误（如上游 429）若直接抛出，
    // 会让整次提取失败；这里记录错误，循环结束后统一处理（必要时改用顺序流重试）。
    let parseError: unknown = null;
    try {
    while (reader.position < segmentEnd) {
      if (Date.now() > deadline) break;
      if (cuesBytes > MAX_SUBTITLE_BYTES) break;
      // 上游连续限流（429）说明跳读策略在该服务上不可行：立即降级为
      // 「从当前位置继续的顺序流」（1 个请求，天然不受限流影响）。
      if (reader.rangeSupported && reader.rateLimitCount >= 2) {
        try {
          const next = await HttpByteReader.openAt(opts, reader.position, true);
          await reader.close();
          reader = next;
          console.warn(
            `[mkv-subtitles] 上游连续限流 ${reader.rateLimitCount} 次，已降级为顺序流继续提取`,
          );
        } catch (err) {
          console.warn(
            '[mkv-subtitles] 限流降级失败:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      let header: ElementHeader;
      try {
        header = await readElementHeader(reader);
      } catch (err) {
        // 读取失败：跳读模式先尝试降级为顺序流接着读（此前直接 break 会把
        // 「已读到的前几分钟」当成完整结果返回并落盘，表现为「字幕只到 2 分钟」）。
        if (reader.rangeSupported) {
          try {
            const next = await HttpByteReader.openAt(opts, reader.position, true);
            await reader.close();
            reader = next;
            console.warn(
              '[mkv-subtitles] 跳读中断，已降级为顺序流继续提取:',
              err instanceof Error ? err.message : err,
            );
            continue;
          } catch (fallbackErr) {
            console.warn(
              '[mkv-subtitles] 降级顺序流失败:',
              fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
            );
          }
        }
        break; // 数据源结束 / 无法继续
      }
      const elemEnd = header.unknownSize ? segmentEnd : reader.position + header.size;

      if (header.id === ID_INFO) {
        while (reader.position < elemEnd) {
          const sub = await readElementHeader(reader);
          if (sub.id === ID_TIMESTAMP_SCALE) {
            timestampScale = readUint(await reader.readExactly(sub.size)) || timestampScale;
          } else {
            await reader.skip(sub.size);
          }
        }
        continue;
      }
      if (header.id === ID_TRACKS) {
        tracks = await parseTracks(reader, header.size);
        continue;
      }
      if (header.id === ID_CLUSTER) {
        sawCluster = true;
        let clusterTs = 0;
        let pendingStart = 0;
        while (reader.position < elemEnd) {
          if (cuesBytes > MAX_SUBTITLE_BYTES) break;
          const sub = await readElementHeader(reader);
          const subEnd = sub.unknownSize ? elemEnd : reader.position + sub.size;
          if (sub.id === ID_CLUSTER_TIMESTAMP) {
            clusterTs = readUint(await reader.readExactly(sub.size));
          } else if (sub.id === ID_SIMPLE_BLOCK) {
            // 先看块头里的轨道号：非目标轨（视频/音频）直接跳过负载，
            // 否则等于把整个视频文件读进内存（旧实现的性能黑洞）
            const head = await reader.peek(Math.min(sub.size, 4));
            if (peekBlockTrack(head) !== trackNumber) {
              await reader.skip(sub.size);
            } else {
              const payload = await reader.readExactly(sub.size);
              const parsed = parseBlockPayload(payload);
              if (parsed && parsed.track === trackNumber) {
                const startMs = (clusterTs + parsed.relative) * (timestampScale / 1_000_000);
                cues.push({ startMs, endMs: startMs, text: parsed.text });
                cuesBytes += parsed.text.length;
              }
            }
          } else if (sub.id === ID_BLOCK_GROUP) {
            let blockPayload: Buffer | null = null;
            let durationTicks = 0;
            let skipGroup = false;
            while (reader.position < subEnd && !skipGroup) {
              const inner = await readElementHeader(reader);
              if (inner.id === ID_BLOCK) {
                const head = await reader.peek(Math.min(inner.size, 4));
                if (peekBlockTrack(head) !== trackNumber) {
                  // 非目标轨：整组跳过（连 BlockDuration 也不需要）
                  skipGroup = true;
                  await reader.skip(subEnd - reader.position);
                } else {
                  blockPayload = await reader.readExactly(inner.size);
                }
              } else if (inner.id === ID_BLOCK_DURATION) {
                durationTicks = readUint(await reader.readExactly(inner.size));
              } else {
                await reader.skip(inner.size);
              }
            }
            if (blockPayload) {
              const parsed = parseBlockPayload(blockPayload);
              if (parsed && parsed.track === trackNumber) {
                const startMs = (clusterTs + parsed.relative) * (timestampScale / 1_000_000);
                const endMs = startMs + durationTicks * (timestampScale / 1_000_000);
                cues.push({ startMs, endMs, text: parsed.text });
                cuesBytes += parsed.text.length;
              }
            }
          } else {
            await reader.skip(subEnd - reader.position);
          }
        }
        emitPartial();
        // 自适应决策：顺序流跑了一小段后，按实测吞吐推算「整集读完要多久」，
        // 太慢就切跳读（从当前 Cluster 边界续读，不重头来）。
        if (!strategyDecided && reader.position > 0) {
          const elapsed = Date.now() - streamStartedAt;
          // 采样窗口：读满 1.2s 或 16MB（快链路提前决策）即评估
          if (elapsed >= SKIP_SAMPLE_MS || reader.position >= SKIP_SAMPLE_BYTES) {
            const total = reader.fileSize || opts.fileSizeHint || 0;
            const rate = reader.position / Math.max(elapsed, 1); // 字节/毫秒
            const projectedMs = total > 0 && rate > 0 ? total / rate : 0;
            if (total > RANGE_SKIP_MIN_FILE_BYTES && projectedMs > SKIP_PROJECT_MS) {
              try {
                const next = await HttpByteReader.openAt(skipOpts, reader.position, false);
                if (next.rangeSupported) {
                  await reader.close();
                  reader = next;
                  console.info(
                    `[mkv-subtitles] 上游吞吐 ${(rate * 1000 / 1048576).toFixed(1)}MB/s，` +
                      `整集预计 ${(projectedMs / 1000).toFixed(0)}s → 切换 Range 跳读（仅下载字幕块）`,
                  );
                } else {
                  await next.close();
                  console.info('[mkv-subtitles] 上游不支持 Range，继续顺序流');
                }
              } catch (err) {
                console.warn(
                  '[mkv-subtitles] 切换跳读失败，继续顺序流:',
                  err instanceof Error ? err.message : err,
                );
              }
            } else if (total > 0) {
              console.info(
                `[mkv-subtitles] 上游吞吐 ${(rate * 1000 / 1048576).toFixed(1)}MB/s，` +
                  `整集预计 ${(projectedMs / 1000).toFixed(0)}s → 保持顺序流`,
              );
            }
            strategyDecided = true;
          }
        }
        // 请求预算保护：跳读模式请求数超限时降级为「从当前位置继续的顺序流」
        // （Range: bytes=pos- 拿到剩余内容，之后按普通顺序流读取，不再产生小请求）。
        if (reader.rangeSupported && reader.requestCount > SKIP_MAX_REQUESTS) {
          try {
            const next = await HttpByteReader.openAt(opts, reader.position, true);
            await reader.close();
            reader = next;
            console.warn(
              `[mkv-subtitles] 跳读请求数超预算（${SKIP_MAX_REQUESTS}），已降级为顺序流继续提取`,
            );
          } catch (err) {
            console.warn(
              '[mkv-subtitles] 降级顺序流失败，继续跳读:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        continue;
      }
      await reader.skip(elemEnd - reader.position);
    }
    } catch (err) {
      parseError = err;
      console.warn(
        '[mkv-subtitles] 解析中断:',
        err instanceof Error ? err.message : err,
      );
    }

    const track = tracks.find((t) => t.trackNumber === trackNumber);
    if (!track) throw new Error(`未找到字幕轨 ${trackNumber}`);
    const format = codecToFormat(track.codecId);
    if (!isTextCodec(track.codecId)) {
      throw new Error(`不支持的字幕编码 ${track.codecId}（位图字幕无法转文本）`);
    }
    // 是否读到文件末尾：读不到说明中途断了（限流/网络），内容只是「已读到的部分」。
    // 此时**不能**当成完整结果（否则会落盘缓存，表现为「字幕只到前几分钟」）。
    const complete =
      !parseError && (reader.eof || reader.position >= segmentEnd);
    if ((parseError || !complete) && !forceStream) {
      // 跳读/自适应模式中断（或没读到末尾）：改用顺序流（单请求、不受限流影响）
      // 重头再解一次；顺序流仍失败时按「不完整」返回，绝不落盘缓存。
      console.warn(
        '[mkv-subtitles] 跳读提取' +
          (parseError ? '出错' : '未读完') +
          `（已取 ${cues.length} 条），改用顺序流重试`,
      );
      await reader.close();
      return extractMkvSubtitleTrack(
        { ...opts, mode: 'stream' },
        trackNumber,
        onPartial,
      );
    }
    if (parseError && cues.length === 0) {
      throw parseError instanceof Error
        ? parseError
        : new Error(String(parseError));
    }
    if (!sawCluster || cues.length === 0) {
      throw new Error('未在容器中读到字幕数据');
    }

    const content = buildSubtitleContent(format, track, cues);

    return {
      content,
      format,
      rangeSupported: reader.rangeSupported,
      complete,
      track: {
        trackNumber: track.trackNumber,
        codecId: track.codecId,
        language: track.language,
        name: track.name,
        format,
        isText: true,
      },
    };
  } finally {
    await reader.close();
  }
}
