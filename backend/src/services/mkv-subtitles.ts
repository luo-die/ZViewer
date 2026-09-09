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
}

export interface MkvExtractResult {
  content: string;
  format: 'ass' | 'srt' | 'vtt';
  track: MkvSubtitleTrackInfo;
  rangeSupported: boolean;
}

export interface MkvSourceOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
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
  private controller = new AbortController();

  private constructor(
    readonly rangeSupported: boolean,
    private readonly opts: MkvSourceOptions,
    initial?: { buf: Buffer; streamReader: ReadableStreamDefaultReader<Uint8Array> | null },
  ) {
    if (initial) {
      this.buf = initial.buf;
      this.bufStart = 0;
      this.streamReader = initial.streamReader;
    }
  }

  static async open(opts: MkvSourceOptions): Promise<HttpByteReader> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(opts.url, {
        headers: { ...(opts.headers ?? {}), Range: 'bytes=0-1' },
        signal: controller.signal,
      });
      const rangeSupported = res.status === 206;
      if (!res.body) throw new Error(`MKV 读取失败: HTTP ${res.status}`);
      // 把首个响应的 body 作为初始缓冲（两种模式都用得上）
      const reader = res.body.getReader();
      const first = await reader.read();
      const buf = first.value ? Buffer.from(first.value) : Buffer.alloc(0);
      const instance = new HttpByteReader(rangeSupported, opts, {
        buf,
        streamReader: rangeSupported ? null : reader,
      });
      instance.controller = controller;
      return instance;
    } finally {
      clearTimeout(timer);
    }
  }

  get bytesRead(): number {
    return this.bufStart + this.buf.length;
  }

  private async fetchRange(start: number, length: number): Promise<Buffer> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.opts.url, {
        headers: {
          ...(this.opts.headers ?? {}),
          Range: `bytes=${start}-${start + length - 1}`,
        },
        signal: controller.signal,
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`MKV 读取失败: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
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
      const length = Math.max(need, CHUNK_SIZE);
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

  /** 前进 n 字节；Range 模式只挪指针（不下载），顺序模式丢弃数据 */
  async skip(n: number): Promise<void> {
    if (n <= 0) return;
    if (this.rangeSupported) {
      this.pos += n;
      return;
    }
    // 顺序模式：把缓冲区推到目标位置
    const target = this.pos + n;
    if (target <= this.bufStart + this.buf.length) {
      this.pos = target;
      const drop = this.pos - this.bufStart;
      this.buf = this.buf.subarray(drop);
      this.bufStart = this.pos;
      return;
    }
    // 需要继续消费流：丢弃已有缓冲，再读一段
    this.pos = target;
    this.buf = Buffer.alloc(0);
    this.bufStart = target;
    await this.ensure(target, 1).catch(() => {
      /* 允许读到末尾 */
    });
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
): Promise<MkvExtractResult> {
  const reader = await HttpByteReader.open(opts);
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

    while (reader.position < segmentEnd) {
      if (Date.now() > deadline) break;
      if (cuesBytes > MAX_SUBTITLE_BYTES) break;
      let header: ElementHeader;
      try {
        header = await readElementHeader(reader);
      } catch {
        break; // 数据源结束
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
            const payload = await reader.readExactly(sub.size);
            const parsed = parseBlockPayload(payload);
            if (parsed && parsed.track === trackNumber) {
              const startMs = (clusterTs + parsed.relative) * (timestampScale / 1_000_000);
              cues.push({ startMs, endMs: startMs, text: parsed.text });
              cuesBytes += parsed.text.length;
            }
          } else if (sub.id === ID_BLOCK_GROUP) {
            let blockPayload: Buffer | null = null;
            let durationTicks = 0;
            while (reader.position < subEnd) {
              const inner = await readElementHeader(reader);
              if (inner.id === ID_BLOCK) {
                blockPayload = await reader.readExactly(inner.size);
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
        continue;
      }
      await reader.skip(elemEnd - reader.position);
    }

    const track = tracks.find((t) => t.trackNumber === trackNumber);
    if (!track) throw new Error(`未找到字幕轨 ${trackNumber}`);
    const format = codecToFormat(track.codecId);
    if (!isTextCodec(track.codecId)) {
      throw new Error(`不支持的字幕编码 ${track.codecId}（位图字幕无法转文本）`);
    }
    if (!sawCluster || cues.length === 0) {
      throw new Error('未在容器中读到字幕数据');
    }

    let content: string;
    if (format === 'ass') {
      const header = track.codecPrivate ? track.codecPrivate.toString('utf8') : '[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
      const body = cues.map((c) => c.text.trimEnd()).filter(Boolean).join('\n');
      content = `${header.endsWith('\n') ? header : `${header}\n`}${body}\n`;
    } else if (format === 'vtt') {
      const lines: string[] = ['WEBVTT', ''];
      cues.forEach((c) => {
        const start = formatSrtTime(c.startMs).replace(',', '.');
        const end = formatSrtTime(c.endMs > c.startMs ? c.endMs : c.startMs + 2000).replace(',', '.');
        lines.push(`${start} --> ${end}`, c.text.trimEnd(), '');
      });
      content = lines.join('\n');
    } else {
      // SRT：用块时间戳合成（若块没有时长，用下一块的起点兜底）
      const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
      const lines: string[] = [];
      ordered.forEach((cue, i) => {
        const next = ordered[i + 1];
        const end = cue.endMs > cue.startMs ? cue.endMs : next ? next.startMs : cue.startMs + 2000;
        lines.push(String(i + 1), `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(end)}`, cue.text.trimEnd(), '');
      });
      content = lines.join('\n');
    }

    return {
      content,
      format,
      rangeSupported: reader.rangeSupported,
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
