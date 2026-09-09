/**
 * 第三方 Emby 兼容服务的「原生 API」字幕兜底（uhdnow 系服务）。
 *
 * 背景：这类服务的 Emby 兼容层通常**不实现字幕端点**
 * （/emby/Videos/{id}/{msId}/Subtitles/{index}/Stream.{fmt} 各种形态全部 404），
 * 但它的原生 API 会把字幕作为独立文件下发，其自研 web 播放器正是
 * `fetch(subtitle.url)` 拿到字幕文本再喂给播放器（见 uhdnow 前端
 * PlaySourceDialog：`subtitles: g.map(x => ({ source: x.url, ... }))`）。
 *
 * 原生 API 契约（从该服务前端 bundle 逆出）：
 *   登录：POST /api/v1/auth/login  body {username, password, totp_code?} → token
 *   资源：GET  /api/v1/stream/movies/{id}/assets    （剧集：/api/v1/stream/episodes/{id}/assets）
 *         → { ok, data: { domain, videos: [...], subtitles: [
 *               { asset_id, url, play_path, download_path, language, format, name } ] } }
 *   认证：请求头 `Authorization: <token>`（裸 token，无 Bearer 前缀）；
 *         字幕/播放文件地址可追加 `?token=<token>`。
 *
 * 只在 Emby 兼容层取不到字幕时使用，取不到就直接抛错，由调用方回退。
 */

const DEFAULT_TIMEOUT_MS = 12000;

/** 原生 API 返回的字幕资源条目 */
export interface NativeSubtitleAsset {
  asset_id?: string;
  /** 字幕文件地址（服务端自用，可能是相对路径） */
  url?: string;
  play_path?: string;
  download_path?: string;
  language?: string | null;
  format?: string | null;
  name?: string | null;
}

export interface NativeAssets {
  /** 文件域名（play_path/download_path 需拼在该域名后） */
  domain?: string;
  videos: Array<Record<string, unknown>>;
  subtitles: NativeSubtitleAsset[];
}

export interface NativeApiOptions {
  serverUrl: string;
  /** 挂载里配置的 Emby API Key（部分服务把它当原生 token 用） */
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  timeoutMs?: number;
}

interface NativeEnvelope<T> {
  ok?: boolean;
  msg?: string;
  data?: T;
}

export class NativeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NativeApiError';
  }
}

export class NativeApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: string | null;

  constructor(private readonly opts: NativeApiOptions) {
    this.baseUrl = (opts.serverUrl || '').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.token = opts.apiKey?.trim() ? opts.apiKey.trim() : null;
  }

  /** 原生 API 请求（自动解包 { ok, data } 信封） */
  private async request<T>(
    path: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown; noAuth?: boolean },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!init?.noAuth) {
      headers.Authorization = await this.ensureToken();
    }
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const msg =
          (parsed as NativeEnvelope<unknown> | null)?.msg ||
          `原生 API 请求失败: ${res.status}`;
        throw new NativeApiError(msg, res.status);
      }
      const env = parsed as NativeEnvelope<T> | null;
      if (env && typeof env === 'object' && 'data' in env) return env.data as T;
      return parsed as T;
    } catch (err) {
      if (err instanceof NativeApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NativeApiError(`原生 API 请求超时（${this.timeoutMs}ms）`);
      }
      throw new NativeApiError(
        err instanceof Error ? `原生 API 连接失败: ${err.message}` : '原生 API 连接失败',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 确保拿到原生 API token（优先复用挂载里的 API Key，否则账号密码登录） */
  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.opts.username || !this.opts.password) {
      throw new NativeApiError('缺少原生 API 凭证（需要账号密码或可用 token）');
    }
    const res = await this.request<
      { token?: string; access_token?: string; accessToken?: string } | null
    >('/api/v1/auth/login', {
      method: 'POST',
      noAuth: true,
      body: {
        username: this.opts.username,
        password: this.opts.password,
      },
    });
    const token = res?.token || res?.access_token || res?.accessToken || '';
    if (!token) throw new NativeApiError('原生 API 登录未返回 token');
    this.token = token;
    return token;
  }

  /** 取影片/剧集的资源列表（含字幕文件） */
  async subtitleAssets(itemId: string): Promise<NativeAssets> {
    const enc = encodeURIComponent;
    const candidates = [
      `/api/v1/stream/movies/${enc(itemId)}/assets`,
      `/api/v1/stream/episodes/${enc(itemId)}/assets`,
    ];
    let lastError: unknown = null;
    for (const path of candidates) {
      try {
        const data = await this.request<{
          domain?: string;
          videos?: Array<Record<string, unknown>>;
          subtitles?: NativeSubtitleAsset[];
        } | null>(path);
        if (data && Array.isArray(data.subtitles)) {
          return {
            domain: data.domain,
            videos: Array.isArray(data.videos) ? data.videos : [],
            subtitles: data.subtitles,
          };
        }
        lastError = new NativeApiError('资源响应中没有 subtitles 字段');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new NativeApiError('未找到字幕资源');
  }

  /** 把资源条目里的地址补成绝对地址（url → domain+play_path → 相对 baseUrl） */
  resolveAssetUrl(asset: NativeSubtitleAsset, domain?: string): string {
    const raw = (asset.url || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw) {
      try {
        return new URL(raw, `${this.baseUrl}/`).toString();
      } catch {
        /* 落到下面的分支 */
      }
    }
    const path = (asset.play_path || asset.download_path || '').trim();
    if (path) {
      const base = domain && /^https?:\/\//i.test(domain) ? domain.replace(/\/+$/, '') : this.baseUrl;
      return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    return '';
  }

  /** 下载字幕文本（同时带 Authorization 头与 ?token= 查询参数） */
  async fetchSubtitleText(url: string): Promise<string> {
    const token = await this.ensureToken();
    const target = new URL(url);
    if (token && !target.searchParams.has('token')) {
      target.searchParams.set('token', token);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(target.toString(), {
        headers: {
          Accept: '*/*',
          Authorization: token,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new NativeApiError(`字幕文件下载失败: HTTP ${res.status}`, res.status);
      }
      return await res.text();
    } catch (err) {
      if (err instanceof NativeApiError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NativeApiError('字幕文件下载超时');
      }
      throw new NativeApiError(
        err instanceof Error ? `字幕文件下载失败: ${err.message}` : '字幕文件下载失败',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 挂载配置 → 原生 API 客户端 */
export function createNativeApiFromMount(mount: {
  serverUrl: string | null;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
}): NativeApiClient | null {
  if (!mount.serverUrl) return null;
  return new NativeApiClient({
    serverUrl: mount.serverUrl,
    apiKey: mount.apiKey,
    username: mount.username,
    password: mount.password,
  });
}
