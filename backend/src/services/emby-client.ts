/**
 * Emby 客户端服务（独立模块，无 Express 依赖）
 *
 * 对应 synctv vendors/emby 的 REST 客户端，适配 ZViewer 技术栈：
 * - 账号密码登录（authenticatebyname）或直接使用 API Key（X-Emby-Token）
 * - 媒体库浏览（Views / Items / Seasons / Episodes）
 * - 播放信息（PlaybackInfo，生成直连 / 转码 URL）
 * 视频流代理由 routes/emby.ts 复用 services/proxy/http-proxy.ts 完成。
 */

import { normalizeServerUrlWithScheme } from './network-utils';

const DEFAULT_TIMEOUT_MS = 10000;

/** Emby 客户端标识头（所有请求都需要，登录请求尤其必需） */
const EMBY_AUTHORIZATION_HEADER =
  'MediaBrowser Client="ZViewer", Device="Web Browser", DeviceId="zviewer-web-' +
  Math.random().toString(36).slice(2, 12) +
  '", Version="1.0.0"';

export interface EmbyLoginResult {
  /** 会话 token（X-Emby-Token） */
  token: string;
  /** 服务器 ID */
  serverId: string;
  /** Emby 用户 ID */
  userId: string;
  /** 用户名 */
  userName: string;
}

export interface EmbyUserInfo {
  Id: string;
  Name: string;
  ServerId: string;
}

/** Emby 媒体流（含字幕流），对应 MediaStreams 数组元素。 */
export interface EmbyMediaStream {
  Index: number;
  Type: string; // 'Video' | 'Audio' | 'Subtitle'
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsExternal?: boolean;
  /** 默认轨（字幕/音轨选择时优先） */
  IsDefault?: boolean;
  /** 强制轨（仅显示外语字幕/歌曲翻译） */
  IsForced?: boolean;
  /**
   * 是否为文本字幕（true=可转 SRT/ASS/VTT，false=PGS/VOBSUB 等位图字幕）。
   * 部分 Emby 版本不返回该字段（undefined），此时按 Codec 判断。
   */
  IsTextSubtitleStream?: boolean;
  DeliveryMethod?: string; // 'External' | 'Embedded' | 'Hls' | 'Encode' ...
  /** 字幕文件地址（服务端下发；相对路径需拼 baseUrl，IsExternalUrl=true 时为绝对地址） */
  DeliveryUrl?: string;
  /** DeliveryUrl 是否为站外绝对地址（为真时不再拼 baseUrl） */
  IsExternalUrl?: boolean;
}

/** Emby 媒体源（MediaSource），含流列表。 */
export interface EmbyMediaSource {
  Id: string;
  Path: string;
  Container?: string;
  DirectPlayUrl?: string;
  TranscodingUrl?: string;
  MediaStreams?: EmbyMediaStream[];
}

export interface EmbyItem {
  Id: string;
  Name: string;
  Type: string;
  /** 是否为文件夹/可展开 */
  IsFolder?: boolean;
  /** 子项数量（剧集/季等） */
  ChildCount?: number;
  /** 是否为文件（可播放） */
  IsFile?: boolean;
  /** 媒体源信息（PlaybackInfo 或带 Fields=MediaSources 时返回） */
  MediaSources?: EmbyMediaSource[];
}

export interface EmbyPlaybackInfo {
  MediaSources: EmbyMediaSource[];
  /** 播放会话 ID（部分 Emby 版本的字幕端点要求带上） */
  PlaySessionId?: string;
}

export interface EmbyClientOptions {
  serverUrl: string;
  /** X-Emby-Token（API Key 或登录后的会话 token） */
  token?: string;
  timeoutMs?: number;
}

interface EmbyRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  /** 相对路径（拼在 baseUrl 后）或绝对 URL（DeliveryUrl 可能是绝对地址） */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** 使用 API Key 请求头（GET 用 query，POST 用 X-Emby-Token） */
  authHeader?: boolean;
  /** 响应类型：默认 json；字幕等纯文本响应传 'text' */
  responseType?: 'json' | 'text';
  /**
   * 放宽 Accept 头为通配符（任意类型）。
   * 字幕端点返回 text 内容，固定 Accept: application/json 时部分 Emby 版本会
   * 拒绝（406/404）；文本响应一律用宽松 Accept。
   */
  acceptAny?: boolean;
}

/** 字幕流提取所需的元信息（来自 PlaybackInfo 的 MediaStreams 元素）。 */
export interface EmbySubtitleStreamRef {
  /** MediaStreams 中的 Index（Emby 字幕端点按该值定位字幕流） */
  index: number;
  /** 字幕编码（subrip/ass/ssa/webvtt/mov_text/pgs...） */
  codec?: string;
  /** 外挂字幕文件（与视频同目录） */
  isExternal?: boolean;
  /** External / Embedded / Hls / Encode */
  deliveryMethod?: string;
  /** Emby 自报的字幕地址（相对或绝对）——最权威的取法 */
  deliveryUrl?: string;
}

/** 字幕提取上下文：定位字幕流所需的全部信息。 */
export interface EmbySubtitleContext {
  itemId: string;
  mediaSourceId: string;
  /** MediaStreams 里的 Index（Emby 常见的定位方式） */
  index: number;
  /**
   * 该字幕在「字幕流数组」中的序号（0 基）。
   * 部分服务端按类型内序号定位字幕，而不是容器全局 Index——两者都试。
   */
  ordinal?: number;
  /** 输出格式（srt/ass/vtt），默认 srt */
  format?: string;
  /** 该媒体源的字幕流数量（用于限定索引试探范围） */
  subtitleCount?: number;
  /** PlaybackInfo 返回的 PlaySessionId（部分版本字幕端点要求） */
  playSessionId?: string;
  /** 字幕流元信息（含 DeliveryUrl 等） */
  stream?: EmbySubtitleStreamRef;
}

/**
 * PlaybackInfo 用的最小 DeviceProfile。
 *
 * 关键：**不声明 SubtitleProfiles 时，Emby 不会为字幕流下发 DeliveryMethod /
 * DeliveryUrl**（实测 delivery=?），客户端就无从取字幕文件。
 * 开源客户端正是靠这个地址取字幕——jellyfin-web 的 playbackmanager.js：
 *   getSubtitleUrl(textStream) =>
 *     textStream.IsExternalUrl ? textStream.DeliveryUrl
 *                              : apiClient.getUrl(textStream.DeliveryUrl)
 * 因此这里声明文本字幕走 External，让 Emby 下发字幕文件地址。
 * DirectPlayProfiles 保持宽松，避免 Emby 因"什么都不支持"改返回转码源
 * （转码源的 MediaStreams 可能不含字幕轨，会让轨道列表变空）。
 */
function buildSubtitleDeviceProfile(): Record<string, unknown> {
  return {
    Name: 'ZViewer',
    MaxStreamingBitrate: 120_000_000,
    MaxStaticBitrate: 100_000_000,
    MusicStreamingTranscodingBitrate: 384_000,
    DirectPlayProfiles: [
      {
        Container:
          'mp4,m4v,mkv,webm,ts,mpegts,m2ts,avi,mov,flv,wmv,mpg,mpeg,ogv,3gp',
        Type: 'Video',
      },
      { Container: 'mp3,aac,m4a,flac,webma,webm,wav,ogg', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: 'h264',
        AudioCodec: 'aac,mp3,ac3',
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: 2,
        BreakOnNonKeyFrames: true,
      },
    ],
    SubtitleProfiles: [
      { Format: 'srt', Method: 'External' },
      { Format: 'subrip', Method: 'External' },
      { Format: 'ass', Method: 'External' },
      { Format: 'ssa', Method: 'External' },
      { Format: 'vtt', Method: 'External' },
      { Format: 'webvtt', Method: 'External' },
      { Format: 'mov_text', Method: 'External' },
      { Format: 'ttml', Method: 'External' },
      { Format: 'sub', Method: 'External' },
    ],
  };
}

/** 诊断用：把字幕流元信息压成一行，便于定位 404 原因 */
function describeSubtitleStream(stream?: EmbySubtitleStreamRef): string {
  if (!stream) return 'stream=?';
  const parts = [
    `index=${stream.index}`,
    `codec=${stream.codec || '?'}`,
    `external=${stream.isExternal === true}`,
    `delivery=${stream.deliveryMethod || '?'}`,
  ];
  if (stream.deliveryUrl) parts.push(`deliveryUrl=${stream.deliveryUrl}`);
  return parts.join(' ');
}

/** 看起来像 HTML 错误页（而非字幕文本）时判为失败 */
function looksLikeHtml(text: string): boolean {
  const head = text.trim().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head>');
}

/**
 * 构造候选字幕地址（按命中概率排序，去重）。
 *
 * Emby 各版本/各投递方式对「定位字幕流」的约定不一致，已确认的失败形态是
 * 标准地址（mediaSourceId + 全局 Index + 扩展名）返回 404 且 PlaybackInfo
 * 未给出 DeliveryUrl/DeliveryMethod，因此把以下差异全部展开：
 *   - 索引：容器全局 Index ↔ 字幕类型内序号（0 基）
 *   - 路径：带 mediaSourceId ↔ 用 itemId 兜底 ↔ 省略 mediaSourceId
 *   - 格式：原格式 ↔ vtt ↔ srt（**关键**：Emby 的字幕端点按扩展名转封装输出，
 *     并非所有格式都支持——ASS 轨道请求 .ass 在部分服务端直接 404，
 *     而 .vtt/.srt 可正常转出；jellyfin-web 取到的 DeliveryUrl 也是 .vtt）
 *   - 会话：带 ↔ 不带 PlaySessionId
 *   - 前缀：/emby 前缀 ↔ 无前缀（serverUrl 本身可能已含 /emby）
 */
export function buildSubtitleCandidates(ctx: EmbySubtitleContext): string[] {
  const enc = encodeURIComponent;
  const format = (ctx.format || 'srt').replace(/^\./, '');
  const item = enc(ctx.itemId);
  const ms = ctx.mediaSourceId ? enc(ctx.mediaSourceId) : '';
  const out: string[] = [];
  const push = (p: string | undefined) => {
    if (p && !out.includes(p)) out.push(p);
  };

  // 1) Emby 自报的 DeliveryUrl
  const delivery = ctx.stream?.deliveryUrl?.trim();
  if (delivery) {
    if (/^https?:\/\//i.test(delivery)) push(delivery);
    else if (delivery.startsWith('/emby/')) push(delivery);
    else if (delivery.startsWith('/')) push(`/emby${delivery}`);
    else push(`/emby/${delivery}`);
  }

  // 2) 索引候选：全局 Index → 类型内序号 → 0/1/2（限定在字幕数附近）
  const idxSet: number[] = [];
  const addIdx = (v: number | undefined) => {
    if (v !== undefined && v >= 0 && !idxSet.includes(v)) idxSet.push(v);
  };
  addIdx(ctx.index);
  addIdx(ctx.ordinal);
  const maxIdx = Math.max((ctx.subtitleCount ?? 1) + 1, ctx.index + 1, 4);
  for (let i = 0; i <= maxIdx && i <= 8; i++) addIdx(i);

  // 3) 各索引 × 各输出格式（原格式 → vtt → srt）× 标准路径
  const formats: string[] = [];
  const addFmt = (f: string) => {
    const v = f.replace(/^\./, '').toLowerCase();
    if (v && !formats.includes(v)) formats.push(v);
  };
  addFmt(format);
  addFmt('vtt');
  addFmt('srt');
  for (const idx of idxSet) {
    for (const fmt of formats) {
      if (ms) push(`/emby/Videos/${item}/${ms}/Subtitles/${idx}/Stream.${fmt}`);
      push(`/emby/Videos/${item}/${item}/Subtitles/${idx}/Stream.${fmt}`);
      push(`/emby/Videos/${item}/Subtitles/${idx}/Stream.${fmt}`);
    }
  }
  // 4) 主索引的其余形态（无扩展名 / format 查询参数 / 无 /emby 前缀）
  const primary = ctx.index;
  if (ms) {
    push(`/emby/Videos/${item}/${ms}/Subtitles/${primary}/Stream`);
    push(`/emby/Videos/${item}/${ms}/Subtitles/${primary}/Stream?format=${format}`);
    push(`/Videos/${item}/${ms}/Subtitles/${primary}/Stream.${format}`);
  }
  push(`/Videos/${item}/${item}/Subtitles/${primary}/Stream.${format}`);
  // 5) PlaySessionId 变体（部分版本要求）
  if (ctx.playSessionId && ms) {
    push(
      `/emby/Videos/${item}/${ms}/Subtitles/${primary}/Stream.${format}?PlaySessionId=${enc(
        ctx.playSessionId,
      )}`,
    );
  }
  return out;
}

export class EmbyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'EmbyError';
  }
}

function normalizeServerUrl(url: string): string {
  // 统一走 network-utils：补默认 scheme（用户输入裸地址 `192.168.1.5:8096`
  // 时若不补 http://，运行时 new URL 会把 "192.168.1.5:" 当非法 scheme 抛错）
  const normalized = normalizeServerUrlWithScheme(url);
  return normalized.length > 0 ? normalized : 'http://localhost:8096';
}

export class EmbyClient {
  /** 归一化后的服务器基础地址（供路由构造直连 URL） */
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: EmbyClientOptions) {
    this.baseUrl = normalizeServerUrl(opts.serverUrl);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(reqOpts: EmbyRequestOptions): Promise<T> {
    const { method = 'GET', path, query, body, authHeader = true } = reqOpts;

    // DeliveryUrl 等字段可能是绝对地址，绝对地址直接使用，不再拼 baseUrl
    const url = /^https?:\/\//i.test(path)
      ? new URL(path)
      : new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: reqOpts.acceptAny ? '*/*' : 'application/json',
      'X-Emby-Authorization': EMBY_AUTHORIZATION_HEADER,
    };
    if (this.opts.token) {
      // 所有请求都通过 X-Emby-Token 头传递 token（Emby 推荐方式）
      headers['X-Emby-Token'] = this.opts.token;
      // GET 请求同时通过 api_key 查询参数传递（兼容旧版 Emby/Jellyfin）
      if (method === 'GET' && authHeader) {
        url.searchParams.set('api_key', this.opts.token);
      }
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        // 尽量取响应体片段：Emby 的 404 常带说明（路由不存在 / 找不到字幕流），
        // 这是定位「字幕 404」最直接的线索
        let detail = '';
        try {
          const text = await res.text();
          detail = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new EmbyError(
          detail
            ? `Emby 请求失败: ${res.status} ${detail}`
            : `Emby 请求失败: ${res.status}`,
          res.status,
          'EMBY_REQUEST_FAILED',
        );
      }
      if (res.status === 204) return undefined as T;
      if (reqOpts.responseType === 'text') {
        return (await res.text()) as unknown as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof EmbyError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new EmbyError(`Emby 请求超时（${this.timeoutMs}ms）`, undefined, 'TIMEOUT');
      }
      throw new EmbyError(
        err instanceof Error ? `Emby 连接失败: ${err.message}` : 'Emby 连接失败',
        undefined,
        'UNREACHABLE',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 账号密码登录，返回会话 token 与用户信息。
   * POST /emby/Users/authenticatebyname
   */
  async login(username: string, password: string): Promise<EmbyLoginResult> {
    const res = await this.request<{
      AccessToken: string;
      ServerId: string;
      User?: { Id: string; Name: string };
    }>({
      method: 'POST',
      path: '/emby/Users/authenticatebyname',
      body: { Username: username, Pw: password },
      authHeader: false,
      // 登录请求需要 Emby 客户端标识头
    });
    if (!res.AccessToken || !res.User?.Id) {
      throw new EmbyError('Emby 登录失败：服务器未返回有效会话', undefined, 'LOGIN_FAILED');
    }
    return {
      token: res.AccessToken,
      serverId: res.ServerId,
      userId: res.User.Id,
      userName: res.User.Name,
    };
  }

  /**
   * 获取当前用户信息。
   * 优先 GET /emby/Users/Me；若失败（部分 Emby 版本返回 500），
   * 回退到 GET /emby/Users 列表，选取第一个管理员用户。
   */
  async me(): Promise<EmbyUserInfo> {
    try {
      const res = await this.request<{ Id: string; Name: string; ServerId: string }>({
        path: '/emby/Users/Me',
      });
      return res;
    } catch {
      // 回退：列出用户，取第一个管理员
      const users = await this.request<Array<{
        Id: string;
        Name: string;
        ServerId?: string;
        Policy?: { IsAdministrator?: boolean };
      }>>({
        path: '/emby/Users',
      });
      const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
      if (!admin) {
        throw new EmbyError('Emby 服务器无可用用户', undefined, 'NO_USER');
      }
      return {
        Id: admin.Id,
        Name: admin.Name,
        ServerId: admin.ServerId ?? '',
      };
    }
  }

  /**
   * 抓取任意 Emby 端点的原始文本（诊断用，例如 web 客户端 JS 源码）。
   * 不做 JSON 解析，返回前 maxBytes 字节的 UTF-8 文本。
   */
  async fetchRawText(pathOrUrl: string, maxBytes = 6 * 1024 * 1024): Promise<string> {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl}`;
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (this.opts.token) headers['X-Emby-Token'] = this.opts.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (!res.ok) {
        throw new EmbyError(`抓取失败: HTTP ${res.status}`, res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, maxBytes).toString('utf-8');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 原始文件直推流地址与请求头（服务端解容器取字幕用）。
   * 不经过转码：MKV 内嵌字幕只能从原始容器里解出来。
   */
  getStaticStreamSource(itemId: string): {
    url: string;
    headers: Record<string, string>;
  } {
    const url = new URL(
      `${this.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream`,
    );
    url.searchParams.set('static', 'true');
    if (this.opts.token) url.searchParams.set('api_key', this.opts.token);
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (this.opts.token) headers['X-Emby-Token'] = this.opts.token;
    return { url: url.toString(), headers };
  }

  /** 服务器公开信息 GET /emby/System/Info/Public（诊断用：确认服务端类型与版本） */
  async systemInfoPublic(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({
      path: '/emby/System/Info/Public',
      authHeader: false,
    });
  }

  /** 媒体库（媒体文件夹）列表 GET /emby/Users/{userId}/Views */
  async userViews(userId: string): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[] }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Views`,
      query: { Fields: 'ChildCount' },
    });
    return res.Items ?? [];
  }

  /** 目录/条目列表 GET /emby/Users/{userId}/Items?ParentId= */
  async items(
    userId: string,
    parentId?: string,
    includeItemTypes?: string,
  ): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[]; TotalRecordCount?: number }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Items`,
      query: {
        ParentId: parentId,
        IncludeItemTypes: includeItemTypes,
        Fields: 'ChildCount,MediaSources,Path',
        Recursive: parentId ? undefined : 'false',
      },
    });
    return res.Items ?? [];
  }

  /**
   * 搜索媒体库 GET /emby/Users/{userId}/Items?SearchTerm=
   *
   * Recursive=true 在用户可见的全部媒体库中搜索，不依赖 ParentId——
   * 这正是"挂载后无法搜索资源库"的缺口：只能逐级点进媒体库/剧集/季。
   * IncludeItemTypes 只保留媒体条目（电影/剧集/季/单集/合集/媒体库），
   * 避免 Person、播放列表、音频等非视频结果污染列表。
   * Series/Season 等文件夹型条目一并返回，前端可继续下钻。
   */
  async search(userId: string, term: string, limit = 60): Promise<EmbyItem[]> {
    const res = await this.request<{ Items?: EmbyItem[] }>({
      path: `/emby/Users/${encodeURIComponent(userId)}/Items`,
      query: {
        SearchTerm: term,
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series,Season,Episode,Video,MusicVideo,BoxSet,CollectionFolder',
        Fields: 'ChildCount,MediaSources,Path',
        Limit: limit,
      },
    });
    return res.Items ?? [];
  }

  /**
   * 播放信息 POST /emby/Items/{itemId}/PlaybackInfo?UserId=
   * 返回媒体源（直连 / 转码 URL 由 Emby 生成）。
   */
  async playbackInfo(
    itemId: string,
    userId: string,
    opts?: {
      /**
       * 带上声明 SubtitleProfiles 的 DeviceProfile —— Emby 才会为字幕流下发
       * DeliveryUrl（取字幕文件的地址）。仅字幕相关调用需要，播放解析路径保持原样。
       */
      subtitleProfile?: boolean;
    },
  ): Promise<EmbyPlaybackInfo> {
    const res = await this.request<EmbyPlaybackInfo>({
      method: 'POST',
      path: `/emby/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      query: { UserId: userId, reqformat: 'json' },
      body: opts?.subtitleProfile
        ? {
            UserId: userId,
            // 只查询媒体信息，不启动播放会话（jellyfin-web 的 IsPlayback=false 同理）
            IsPlayback: false,
            AutoOpenLiveStream: false,
            EnableDirectPlay: true,
            EnableDirectStream: true,
            EnableTranscoding: true,
            AllowVideoStreamCopy: true,
            AllowAudioStreamCopy: true,
            DeviceProfile: buildSubtitleDeviceProfile(),
          }
        : {},
    });
    if (!res.MediaSources?.length) {
      throw new EmbyError('Emby 未返回可用媒体源', undefined, 'NO_MEDIA_SOURCE');
    }
    return res;
  }

  /** 停止转码 POST /emby/Videos/ActiveEncodings/Delete */
  async deleteActiveEncodings(
    deviceId: string,
    playSessionId: string,
  ): Promise<void> {
    await this.request<void>({
      method: 'POST',
      path: '/emby/Videos/ActiveEncodings/Delete',
      body: { DeviceId: deviceId, PlaySessionId: playSessionId },
    });
  }

  /**
   * 获取指定字幕轨道的内容文本（SRT/ASS/VTT）。
   *
   * Emby 的字幕投递地址随版本/媒体源类型变化，单一地址（mediaSourceId + 扩展名）
   * 在部分服务端会 404——已确认的失败形态：
   *   GET /emby/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.srt → 404
   * 因此按以下优先级逐个尝试，命中即返回：
   *   1. PlaybackInfo 自报的 DeliveryUrl（Emby 直接告诉客户端该用哪个地址）
   *   2. 标准三段式（mediaSourceId + index + 扩展名）
   *   3. mediaSourceId 用 itemId 兜底（单媒体源时 Emby/Jellyfin 接受 itemId）
   *   4. 省略 mediaSourceId（部分版本的字幕端点不需要它）
   *   5. 不带扩展名（外挂字幕原始文件）
   *   6. HLS 投递（DeliveryMethod=Hls 时字幕在 subtitles.m3u8 里，Stream.* 必然 404）
   *
   * 404 继续尝试下一个地址；401/500 等真实错误立即抛出。
   * 全部失败时抛出带诊断信息的错误（含每个地址的状态与字幕流元信息），
   * 便于直接定位是 mediaSourceId、index 还是投递方式的问题。
   */
  async subtitleContent(
    itemId: string,
    mediaSourceId: string,
    index: number,
    ext?: string,
    stream?: EmbySubtitleStreamRef,
    extra?: { ordinal?: number; subtitleCount?: number; playSessionId?: string },
  ): Promise<string> {
    const ctx: EmbySubtitleContext = {
      itemId,
      mediaSourceId,
      index,
      ordinal: extra?.ordinal,
      format: ext,
      subtitleCount: extra?.subtitleCount,
      playSessionId: extra?.playSessionId,
      stream,
    };
    // 候选很多（索引 × 格式 × 路径形态），限制上限避免失败路径长时间阻塞；
    // 排序保证「主索引 × 原格式/vtt/srt」排在最前，正常情况 1-3 次请求内命中。
    // 上限压到 10：部分第三方服务（UHD Media Server）对密集请求会 429，
    // 试完十几种形态仍未命中说明该服务根本没有字幕端点，继续试只会把
    // 限流额度打满，连播放本身都被拖累。
    const candidates = buildSubtitleCandidates(ctx).slice(0, 10);

    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const text = await this.request<string>({
          path: candidate,
          authHeader: true,
          responseType: 'text',
          acceptAny: true,
        });
        if (text && text.trim() && !looksLikeHtml(text)) return text;
        failures.push(`${candidate} → ${text && text.trim() ? 'HTML 错误页' : '空响应'}`);
      } catch (err) {
        const status = err instanceof EmbyError ? err.status : undefined;
        failures.push(
          `${candidate} → ${status ?? (err instanceof Error ? err.message : String(err))}`,
        );
        if (status !== 404) throw err;
      }
    }

    // HLS 字幕兜底（DeliveryMethod=Hls 时只有 subtitles.m3u8 可用）
    const hls = await this.subtitleFromHls(itemId, mediaSourceId, index).catch(() => null);
    if (hls) return hls;

    throw new EmbyError(
      `Emby 未返回字幕内容（${describeSubtitleStream(stream)} ms=${mediaSourceId || '-'} ordinal=${
        extra?.ordinal ?? '-'
      }）已尝试: ${failures.join(' | ')}`,
      undefined,
      'SUBTITLE_UNAVAILABLE',
    );
  }

  /**
   * 逐个探测候选字幕地址并返回每个地址的状态与响应预览（诊断用，不抛错）。
   * 用于 /api/subtitles/emby-diagnose 一次性定位该 Emby 实例真正可用的字幕地址。
   */
  async probeSubtitleCandidates(
    ctx: EmbySubtitleContext,
  ): Promise<Array<{ url: string; status: number | 'error'; contentType?: string; preview?: string }>> {
    const results: Array<{
      url: string;
      status: number | 'error';
      contentType?: string;
      preview?: string;
    }> = [];
    // 追加 HLS 字幕播放列表（DeliveryMethod=Hls 时唯一的取字幕入口）
    const extra: string[] = [];
    if (ctx.mediaSourceId) {
      const enc = encodeURIComponent;
      extra.push(
        `/emby/Videos/${enc(ctx.itemId)}/${enc(
          ctx.mediaSourceId,
        )}/Subtitles/${ctx.index}/subtitles.m3u8`,
      );
      if (ctx.ordinal !== undefined) {
        extra.push(
          `/emby/Videos/${enc(ctx.itemId)}/${enc(
            ctx.mediaSourceId,
          )}/Subtitles/${ctx.ordinal}/subtitles.m3u8`,
        );
      }
    }
    // 诊断端点同样限制请求数：密集探测会触发上游 429，反而污染诊断结论
    for (const candidate of [...buildSubtitleCandidates(ctx), ...extra].slice(0, 16)) {
      try {
        const text = await this.request<string>({
          path: candidate,
          authHeader: true,
          responseType: 'text',
          acceptAny: true,
        });
        results.push({
          url: candidate,
          status: 200,
          preview: (text || '').slice(0, 120).replace(/\s+/g, ' '),
        });
      } catch (err) {
        const status = err instanceof EmbyError ? err.status : 'error';
        results.push({
          url: candidate,
          status: status ?? 'error',
          preview: err instanceof Error ? err.message.slice(0, 80) : undefined,
        });
      }
    }
    return results;
  }

  /**
   * HLS 字幕兜底：Emby 以 Hls 方式投递字幕时，字幕分片由
   * GET /emby/Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/subtitles.m3u8 描述，
   * 逐段取回 VTT 并拼接（去掉每段重复的 WEBVTT 头）。
   */
  private async subtitleFromHls(
    itemId: string,
    mediaSourceId: string,
    index: number,
  ): Promise<string | null> {
    const enc = encodeURIComponent;
    const playlistPath = `/emby/Videos/${enc(itemId)}/${enc(
      mediaSourceId || itemId,
    )}/Subtitles/${index}/subtitles.m3u8`;
    let playlist: string;
    try {
      playlist = await this.request<string>({
        path: playlistPath,
        authHeader: true,
        responseType: 'text',
        acceptAny: true,
      });
    } catch {
      return null;
    }
    if (!playlist || !playlist.includes('#EXTM3U')) return null;

    const segments = playlist
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (segments.length === 0) return null;

    const base = new URL(`${this.baseUrl}${playlistPath}`);
    const parts: string[] = ['WEBVTT', ''];
    let fetched = 0;
    for (const seg of segments) {
      const segUrl = /^https?:\/\//i.test(seg) ? seg : new URL(seg, base).toString();
      try {
        const body = await this.request<string>({
          path: segUrl,
          authHeader: true,
          responseType: 'text',
          acceptAny: true,
        });
        if (!body) continue;
        parts.push(body.replace(/^WEBVTT[^\n]*\r?\n/, '').trim(), '');
        fetched++;
      } catch {
        /* 单个分片失败跳过，尽量返回可用部分 */
      }
    }
    if (fetched === 0) return null;
    return parts.join('\n');
  }
}

/**
 * 挂载配置 → Emby 客户端。
 * 优先使用 API Key；否则用账号密码登录（登录结果可缓存）。
 */
export async function createEmbyClientFromMount(mount: {
  serverUrl: string | null;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}): Promise<EmbyClient> {
  const serverUrl = mount.serverUrl ?? '';
  if (mount.apiKey) {
    return new EmbyClient({ serverUrl, token: mount.apiKey });
  }
  if (mount.username && mount.password) {
    const client = new EmbyClient({ serverUrl });
    const result = await client.login(mount.username, mount.password);
    return new EmbyClient({ serverUrl, token: result.token });
  }
  throw new EmbyError('Emby 挂载缺少 API Key 或账号密码', undefined, 'MISSING_CREDENTIALS');
}
