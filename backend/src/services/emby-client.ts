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
  DeliveryMethod?: string; // 'External' | 'Embedded' | 'Hls' ...
  DeliveryUrl?: string;
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
        let detail = '';
        try {
          const j = (await res.json()) as { Message?: string; Error?: { message?: string } };
          detail = j.Message ?? j.Error?.message ?? '';
        } catch {
          /* ignore */
        }
        throw new EmbyError(
          detail || `Emby 请求失败: ${res.status}`,
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
  async playbackInfo(itemId: string, userId: string): Promise<EmbyPlaybackInfo> {
    const res = await this.request<EmbyPlaybackInfo>({
      method: 'POST',
      path: `/emby/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      query: { UserId: userId, reqformat: 'json' },
      body: {},
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
  ): Promise<string> {
    const format = (ext || 'srt').replace(/^\./, '');
    const enc = encodeURIComponent;
    const candidates: string[] = [];
    const push = (p: string | undefined) => {
      if (p && !candidates.includes(p)) candidates.push(p);
    };

    // 1) Emby 自报的 DeliveryUrl
    const delivery = stream?.deliveryUrl?.trim();
    if (delivery) {
      if (/^https?:\/\//i.test(delivery)) push(delivery);
      else if (delivery.startsWith('/emby/')) push(delivery);
      else if (delivery.startsWith('/')) push(`/emby${delivery}`);
      else push(`/emby/${delivery}`);
    }
    // 2) 标准三段式
    if (mediaSourceId) {
      push(`/emby/Videos/${enc(itemId)}/${enc(mediaSourceId)}/Subtitles/${index}/Stream.${format}`);
    }
    // 3) mediaSourceId 用 itemId 兜底
    push(`/emby/Videos/${enc(itemId)}/${enc(itemId)}/Subtitles/${index}/Stream.${format}`);
    // 4) 省略 mediaSourceId
    push(`/emby/Videos/${enc(itemId)}/Subtitles/${index}/Stream.${format}`);
    // 5) 不带扩展名
    if (mediaSourceId) {
      push(`/emby/Videos/${enc(itemId)}/${enc(mediaSourceId)}/Subtitles/${index}/Stream`);
    }

    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const text = await this.request<string>({
          path: candidate,
          authHeader: true,
          responseType: 'text',
          acceptAny: true,
        });
        if (text && text.trim()) return text;
        failures.push(`${candidate} → 空响应`);
      } catch (err) {
        const status = err instanceof EmbyError ? err.status : undefined;
        failures.push(
          `${candidate} → ${status ?? (err instanceof Error ? err.message : String(err))}`,
        );
        if (status !== 404) throw err;
      }
    }

    // 6) HLS 字幕兜底（DeliveryMethod=Hls 或以上地址全 404）
    const hls = await this.subtitleFromHls(itemId, mediaSourceId, index).catch(() => null);
    if (hls) return hls;

    throw new EmbyError(
      `Emby 未返回字幕内容（${describeSubtitleStream(stream)}）已尝试: ${failures.join(' | ')}`,
      undefined,
      'SUBTITLE_UNAVAILABLE',
    );
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
