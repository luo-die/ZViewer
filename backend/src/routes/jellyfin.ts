/**
 * Jellyfin 路由层
 *
 * 与 emby.ts 结构一致，但 type 为 'jellyfin'，Jellyfin 是 Emby 开源分支，API 完全兼容。
 * 分离式架构：REST 客户端在 services/jellyfin-client.ts（重导出 emby-client）。
 */
import {
  extractErrorMessage,
  ensureHttpsProbe,
  maybeUpgradeDirectUrl,
  probeForMountSave,
} from '../modules/shared/mount-utils';
import {
  canUseDirectLink,
  resolveAccessibleMount,
  toOwnMountDto,
} from '../modules/shared/mount-share';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { UserMount } from '../entities/UserMount';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { JellyfinClient, JellyfinError } from '../services/jellyfin-client';
import { detectMediaFormat } from '../services/mediaFormat';
import { resolveUserMount, resolveMovieStream, proxyHttpUpstream } from '../services/proxy';
import { normalizeServerUrlWithScheme } from '../services/network-utils';

const router = Router();

const userMountRepository = () => AppDataSource.getRepository(UserMount);

function extractErrorCode(err: unknown): string {
  return err instanceof JellyfinError ? err.code ?? 'JELLYFIN_ERROR' : 'UNREACHABLE';
}

async function resolveJellyfinSession(mount: UserMount): Promise<{
  client: JellyfinClient;
  userId: string;
  token: string;
}> {
  const serverUrl = mount.serverUrl;
  if (!serverUrl) {
    throw new JellyfinError('该挂载未配置服务器地址', undefined, 'INVALID_URL');
  }

  let token = mount.apiKey ?? '';
  if (!token) {
    if (!mount.username || !mount.password) {
      throw new JellyfinError('Jellyfin 挂载缺少 API Key 或账号密码', undefined, 'MISSING_CREDENTIALS');
    }
    const loginClient = new JellyfinClient({ serverUrl });
    const loginResult = await loginClient.login(mount.username, mount.password);
    token = loginResult.token;
  }

  const client = new JellyfinClient({ serverUrl, token });
  let userId = mount.embyUserId ?? '';
  if (!userId) {
    try {
      const me = await client.me();
      userId = me.Id;
      mount.embyUserId = userId;
      await userMountRepository().save(mount);
    } catch {
      /* ignore */
    }
  }
  return { client, userId, token };
}

/** 图片类型白名单（避免把任意路径透传给上游） */
const IMAGE_TYPES = new Set(['Primary', 'Thumb', 'Backdrop', 'Logo', 'Banner', 'Art', 'Disc', 'Box']);

/** 数值查询参数解析（越界回落到默认值） */
function clampQueryNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function mapJellyfinEntry(item: {
  Id: string;
  Name: string;
  Type: string;
  IsFolder?: boolean;
  IsFile?: boolean;
  ChildCount?: number;
  ImageTags?: Record<string, string | undefined>;
  PrimaryImageAspectRatio?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesName?: string;
  ProductionYear?: number;
  RunTimeTicks?: number;
}) {
  const fileTypes = new Set(['Movie', 'Video', 'Episode', 'MusicVideo', 'TvSeries']);
  const isFile = fileTypes.has(item.Type) || item.IsFile === true;
  return {
    name: item.Name,
    path: item.Id,
    type: (isFile ? 'file' : 'directory') as 'file' | 'directory',
    embyType: item.Type,
    childCount: item.ChildCount ?? 0,
    // 缩略图：只下发 tag，图片地址由前端拼 /api/jellyfin/mounts/:id/image（含鉴权）
    imageTag: item.ImageTags?.Primary ?? null,
    imageAspectRatio: item.PrimaryImageAspectRatio ?? null,
    indexNumber: item.IndexNumber ?? null,
    parentIndexNumber: item.ParentIndexNumber ?? null,
    seriesName: item.SeriesName ?? null,
    productionYear: item.ProductionYear ?? null,
    runtimeTicks: item.RunTimeTicks ?? null,
  };
}

router.use(authenticateToken);

// 列表 - GET /mounts（仅自己的挂载；他人共享的见 /api/mounts/shared）
router.get('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.userId;
    const mounts = await userMountRepository().find({
      where: { userId, type: 'jellyfin' },
      order: { createdAt: 'DESC' },
    });
    res.json({ success: true, mounts: mounts.map(toOwnMountDto) });
  } catch (err) {
    console.error('[jellyfin] list mounts error:', err);
    res.status(500).json({ success: false, message: '获取 Jellyfin 挂载列表失败' });
  }
});

// 测试连接 - POST /mounts/test
router.post('/mounts/test', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { serverUrl, apiKey, username, password } = req.body ?? {};
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }
    if (!apiKey && (!username || !password)) {
      res.status(400).json({ success: false, message: '请填写 API Key，或用户名与密码', code: 'MISSING_CREDENTIALS' });
      return;
    }
    try {
      let token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '';
      if (!token) {
        const loginClient = new JellyfinClient({ serverUrl: serverUrl.trim() });
        const result = await loginClient.login(String(username), String(password));
        token = result.token;
      }
      const client = new JellyfinClient({ serverUrl: serverUrl.trim(), token });
      const me = await client.me();
      res.json({ success: true, userId: me.Id, userName: me.Name, serverId: me.ServerId });
    } catch (err) {
      const code = extractErrorCode(err);
      res.status(400).json({ success: false, message: extractErrorMessage(err, '连接 Jellyfin 失败'), code });
    }
  } catch (err) {
    console.error('[jellyfin] test mount error:', err);
    res.status(500).json({ success: false, message: '测试 Jellyfin 连接失败' });
  }
});

// 创建 - POST /mounts
router.post('/mounts', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { name, serverUrl, apiKey, username, password, directLink } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: '挂载名称不能为空', code: 'INVALID_PARAMS' });
      return;
    }
    if (typeof serverUrl !== 'string' || !serverUrl.trim()) {
      res.status(400).json({ success: false, message: '服务器地址不能为空', code: 'INVALID_URL' });
      return;
    }
    if (!apiKey && (!username || !password)) {
      res.status(400).json({ success: false, message: '请填写 API Key，或用户名与密码', code: 'MISSING_CREDENTIALS' });
      return;
    }

    let embyUserId: string | null = null;
    try {
      let token = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : '';
      if (!token) {
        const loginClient = new JellyfinClient({ serverUrl: serverUrl.trim() });
        const result = await loginClient.login(String(username), String(password));
        token = result.token;
      }
      const client = new JellyfinClient({ serverUrl: serverUrl.trim(), token });
      const me = await client.me();
      embyUserId = me.Id;
    } catch (err) {
      res.status(400).json({ success: false, message: extractErrorMessage(err, '连接 Jellyfin 失败'), code: extractErrorCode(err) });
      return;
    }

    const repo = userMountRepository();
    const mount = repo.create({
      userId: req.user!.userId,
      type: 'jellyfin',
      name: name.trim(),
      // 规范化后落库：补 scheme 避免运行时 new URL 抛错
      serverUrl: normalizeServerUrlWithScheme(serverUrl),
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null,
      username: typeof username === 'string' && username.trim() ? username.trim() : null,
      password: typeof password === 'string' && password ? password : null,
      embyUserId,
      directLink: directLink === true,
    });
    await repo.save(mount);
    const httpsWarning = await probeForMountSave(mount);
    res.status(201).json({
      success: true,
      mount: toOwnMountDto(mount),
      ...(httpsWarning ? { warning: httpsWarning } : {}),
    });
  } catch (err) {
    console.error('[jellyfin] create mount error:', err);
    res.status(500).json({ success: false, message: '创建 Jellyfin 挂载失败' });
  }
});

// 更新 - PUT /mounts/:id
router.put('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'jellyfin' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    const { name, serverUrl, apiKey, username, password, directLink } = req.body ?? {};
    if (typeof name === 'string' && name.trim()) mount.name = name.trim();
    if (typeof serverUrl === 'string' && serverUrl.trim()) {
      mount.serverUrl = normalizeServerUrlWithScheme(serverUrl);
      mount.embyUserId = null;
      mount.httpsDirect = null; // 服务器变更后 HTTPS 能力需重新探测
    }
    if (apiKey !== undefined) mount.apiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
    if (username !== undefined) mount.username = typeof username === 'string' && username.trim() ? username.trim() : null;
    if (password !== undefined) mount.password = typeof password === 'string' && password ? password : null;
    if (directLink !== undefined) mount.directLink = directLink === true;
    try {
      const session = await resolveJellyfinSession(mount);
      mount.embyUserId = session.userId || null;
    } catch { /* 保持原样 */ }
    await repo.save(mount);
    const httpsWarning = await probeForMountSave(mount);
    res.json({
      success: true,
      mount: toOwnMountDto(mount),
      ...(httpsWarning ? { warning: httpsWarning } : {}),
    });
  } catch (err) {
    console.error('[jellyfin] update mount error:', err);
    res.status(500).json({ success: false, message: '更新 Jellyfin 挂载失败' });
  }
});

// 删除 - DELETE /mounts/:id
router.delete('/mounts/:id', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const repo = userMountRepository();
    const mount = await repo.findOneBy({ id: mountId, userId: req.user!.userId, type: 'jellyfin' });
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    await repo.remove(mount);
    res.json({ success: true });
  } catch (err) {
    console.error('[jellyfin] delete mount error:', err);
    res.status(500).json({ success: false, message: '删除 Jellyfin 挂载失败' });
  }
});

// 浏览 - GET /mounts/:id/browse?path=（自己的挂载或他人共享给自己的挂载）
router.get('/mounts/:id/browse', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const mount = (await resolveAccessibleMount(mountId, 'jellyfin', req.user!.userId))?.mount;
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    const browsePath = typeof req.query.path === 'string' ? req.query.path : '';
    const session = await resolveJellyfinSession(mount);
    let items: { Id: string; Name: string; Type: string; IsFolder?: boolean; IsFile?: boolean; ChildCount?: number }[] = [];
    if (!browsePath || browsePath === 'views' || browsePath === '/') {
      items = await session.client.userViews(session.userId);
    } else {
      items = await session.client.items(session.userId, browsePath);
    }
    res.json({ success: true, entries: items.map(mapJellyfinEntry) });
  } catch (err) {
    console.error('[jellyfin] browse mount error:', err);
    const code = extractErrorCode(err);
    const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
    res.status(status).json({ success: false, message: extractErrorMessage(err, '浏览 Jellyfin 失败'), code });
  }
});

// 搜索 - GET /mounts/:id/search?q=&limit=
// 与 emby.ts 对齐：递归搜索用户可见的全部媒体库。
router.get('/mounts/:id/search', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ success: false, message: '搜索关键词不能为空', code: 'INVALID_PARAMS' });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 200)
      : 60;

    const mount = (await resolveAccessibleMount(mountId, 'jellyfin', req.user!.userId))?.mount;
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const session = await resolveJellyfinSession(mount);
    if (!session.userId) {
      res.status(400).json({
        success: false,
        message: '未获取到 Jellyfin 用户信息，请重新保存该挂载配置',
        code: 'NO_USER',
      });
      return;
    }
    const items = await session.client.search(session.userId, query, limit);
    res.json({ success: true, entries: items.map(mapJellyfinEntry) });
  } catch (err) {
    console.error('[jellyfin] search mount error:', err);
    const code = extractErrorCode(err);
    const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
    res.status(status).json({
      success: false,
      message: extractErrorMessage(err, '搜索 Jellyfin 媒体库失败'),
      code,
    });
  }
});

// 图片代理 - GET /mounts/:id/image?itemId=&tag=&type=Primary&maxWidth=&maxHeight=
// 与 emby.ts 对齐：浏览列表缩略图由后端带 token 取图后中转。
router.get('/mounts/:id/image', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const itemId = typeof req.query.itemId === 'string' ? req.query.itemId.trim() : '';
    if (!itemId) {
      res.status(400).json({ success: false, message: 'itemId 不能为空', code: 'INVALID_PARAMS' });
      return;
    }
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : 'Primary';
    const type = IMAGE_TYPES.has(typeRaw) ? typeRaw : 'Primary';
    const tag = typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined;
    const maxWidth = clampQueryNumber(req.query.maxWidth, 16, 1280, 320);
    const maxHeight = clampQueryNumber(req.query.maxHeight, 16, 1920, 480);

    const mount = (await resolveAccessibleMount(mountId, 'jellyfin', req.user!.userId))?.mount;
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const session = await resolveJellyfinSession(mount);
    const upstreamUrl = session.client.buildItemImageUrl(itemId, {
      type,
      tag,
      maxWidth,
      maxHeight,
      quality: 90,
    });

    await proxyHttpUpstream(req, res, {
      url: upstreamUrl,
      headers: {
        extra: {
          'X-Emby-Token': session.token,
          Referer: session.client.baseUrl,
        },
      },
      cors: 'wildcard',
      defaultContentType: 'image/jpeg',
      cacheControl: 'public, max-age=86400',
      timeoutMs: 15_000,
      logTag: 'jellyfin-image',
      errorMessage: '获取 Jellyfin 图片失败',
    });
  } catch (err) {
    console.error('[jellyfin] image proxy error:', err);
    if (!res.headersSent) {
      const code = extractErrorCode(err);
      res.status(code === 'AUTH_FAILED' ? 401 : 502).json({
        success: false,
        message: extractErrorMessage(err, '获取 Jellyfin 图片失败'),
        code,
      });
    } else {
      res.destroy();
    }
  }
});

// 整季/全剧剧集 - GET /mounts/:id/episodes?path=&limit=
router.get('/mounts/:id/episodes', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountId = Number(req.params.id);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: '挂载 ID 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const itemId = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    if (!itemId) {
      res.status(400).json({ success: false, message: 'path 不能为空', code: 'INVALID_PARAMS' });
      return;
    }
    const limit = clampQueryNumber(req.query.limit, 1, 1000, 500);

    const mount = (await resolveAccessibleMount(mountId, 'jellyfin', req.user!.userId))?.mount;
    if (!mount) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }

    const session = await resolveJellyfinSession(mount);
    if (!session.userId) {
      res.status(400).json({
        success: false,
        message: '未获取到 Jellyfin 用户信息，请重新保存该挂载配置',
        code: 'NO_USER',
      });
      return;
    }

    const items = await session.client.collectPlayableDescendants(session.userId, itemId, {
      maxItems: limit,
    });
    res.json({
      success: true,
      entries: items.map(mapJellyfinEntry),
      total: items.length,
      truncated: items.length >= limit,
    });
  } catch (err) {
    console.error('[jellyfin] episodes error:', err);
    const code = extractErrorCode(err);
    const status = code === 'AUTH_FAILED' ? 401 : code === 'TIMEOUT' ? 504 : 400;
    res.status(status).json({
      success: false,
      message: extractErrorMessage(err, '获取 Jellyfin 剧集列表失败'),
      code,
    });
  }
});

// 解析 - GET /resolve?mountId=&path=
router.get('/resolve', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const mountIdRaw = req.query.mountId;
    const pathRaw = req.query.path;
    if (mountIdRaw === undefined || pathRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 mountId 或 path 参数', code: 'INVALID_PARAMS' });
      return;
    }
    const mountId = Number(mountIdRaw);
    if (Number.isNaN(mountId)) {
      res.status(400).json({ success: false, message: 'mountId 不正确', code: 'INVALID_PARAMS' });
      return;
    }
    const itemId = typeof pathRaw === 'string' ? pathRaw : '';
    if (!itemId.trim()) {
      res.status(400).json({ success: false, message: 'itemId 不能为空', code: 'INVALID_PARAMS' });
      return;
    }
    const access = await resolveAccessibleMount(mountId, 'jellyfin', req.user!.userId);
    if (!access) {
      res.status(404).json({ success: false, message: '挂载不存在或无权限' });
      return;
    }
    const { mount, shared } = access;
    const session = await resolveJellyfinSession(mount);
    const info = await session.client.playbackInfo(itemId, session.userId);
    const source = info.MediaSources[0];
    if (!source) {
      res.status(400).json({ success: false, message: '该条目无可用媒体源', code: 'NO_MEDIA_SOURCE' });
      return;
    }
    const title = source.Path?.split(/[\\/]/).pop() || `item-${itemId}`;

    // ── 音频编码兼容性检测 ──────────────────────────────
    // 与 emby.ts 一致：检测到浏览器不支持的音轨时切换为 Jellyfin 服务端转码 HLS
    const BROWSER_SUPPORTED_AUDIO = new Set(['aac', 'mp3', 'flac', 'opus', 'vorbis']);
    const audioStream = source.MediaStreams?.find((s) => s.Type === 'Audio');
    const audioCodec = audioStream?.Codec ?? null;
    const audioIncompatible =
      !!audioStream &&
      !!audioStream.Codec &&
      !BROWSER_SUPPORTED_AUDIO.has(audioStream.Codec.toLowerCase());
    // 不兼容即转码：与 emby.ts 一致，不再设全局开关门控
    const needsAudioTranscode = audioIncompatible;

    const format = needsAudioTranscode ? 'hls' : detectMediaFormat(source.Path ?? title);
    const transcodeQuery = needsAudioTranscode ? '&at=1' : '';
    const proxyUrl = `/api/jellyfin/proxy?mountId=${mountId}&path=${encodeURIComponent(itemId)}${transcodeQuery}`;
    // 配置期探测的 HTTPS 能力：源站支持 TLS 时升级 http 直链为 https
    // （浏览器直连零带宽）；否则保持 http，HTTPS 页面下走服务器代理
    const directUrlRaw = needsAudioTranscode
      ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
      : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}`;
    const httpsDirect = await ensureHttpsProbe(mount);
    const directUrl = maybeUpgradeDirectUrl(directUrlRaw, httpsDirect);
    // 他人共享的挂载：默认不下发直连 URL（其中含源站地址与 api_key），
    // 需挂载主在共享设置中显式开启「允许直链直连」
    const allowDirect = canUseDirectLink(mount, shared);
    res.json({
      success: true,
      title,
      videoUrl: proxyUrl,
      ...(allowDirect ? { directUrl } : {}),
      format,
      duration: 0,
      audioCodec,
      needsAudioTranscode,
      jellyfin: { itemId, container: source.Container ?? '' },
    });
  } catch (err) {
    console.error('[jellyfin] resolve error:', err);
    res.status(400).json({ success: false, message: extractErrorMessage(err, '解析 Jellyfin 条目失败'), code: extractErrorCode(err) });
  }
});

// 代理 - GET /proxy?mountId=&path=
router.get('/proxy', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const resolved = await resolveUserMount(req, res, 'jellyfin');
  if (!resolved) return;
  const { mount, targetPath } = resolved;
  try {
    const session = await resolveJellyfinSession(mount);
    const audioTranscode = req.query.at === '1';
    const upstreamUrl = audioTranscode
      ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
      : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(targetPath)}/stream?static=true&api_key=${session.token}`;

    await proxyHttpUpstream(req, res, {
      url: upstreamUrl,
      headers: { extra: { 'X-Emby-Token': session.token, Referer: session.client.baseUrl } },
      cors: 'wildcard',
      defaultContentType: audioTranscode ? 'application/x-mpegURL' : 'video/mp4',
      // 转码冷启动：Jellyfin 需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
      timeoutMs: audioTranscode ? 90_000 : undefined,
      logTag: audioTranscode ? 'jellyfin-proxy-transcode' : 'jellyfin-proxy',
      errorMessage: 'Jellyfin 视频流代理失败',
    });
  } catch (err) {
    console.error('[jellyfin] proxy error:', err);
    const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
    res.status(status).json({ success: false, message: extractErrorMessage(err, '代理 Jellyfin 视频流失败'), code: extractErrorCode(err) });
  }
});

// 基于影片 ID 的流代理 - GET /stream?movieId=
// 与 /proxy 的区别：/stream 不依赖 userId 查挂载，而是直接从 Movie 表读取 serverUrl，
// 再通过 serverUrl + type='jellyfin' 在 UserMount 表中查找挂载凭证，
// 这样房间内任何成员（含观众）都能通过 movieId 访问影片流。
router.get('/stream', async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const movieIdRaw = req.query.movieId;
    if (movieIdRaw === undefined) {
      res.status(400).json({ success: false, message: '缺少 movieId 参数' });
      return;
    }
    const movieId = Number(movieIdRaw);
    if (Number.isNaN(movieId)) {
      res.status(400).json({ success: false, message: 'movieId 不正确' });
      return;
    }

    const { movie, mount } = await resolveMovieStream(movieId, 'jellyfin');
    if (!mount) {
      res.status(404).json({ success: false, message: '未找到对应的 Jellyfin 挂载配置' });
      return;
    }

    const session = await resolveJellyfinSession(mount);
    const itemId = movie.path!;
    // 转码判定：与 emby.ts 一致，resolve 阶段检测到音轨编码不兼容时 format 持久化为 'hls'
    // static=1：强制直推原始文件（浏览器端解容器取字幕用，与 emby.ts 一致）
    const forceStatic = req.query.static === '1';
    const audioTranscode =
      !forceStatic &&
      (req.query.at === '1' || (movie.format ?? '').toLowerCase() === 'hls');
    const upstreamUrl = audioTranscode
      ? `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/main.m3u8?api_key=${session.token}&AudioCodec=aac&TranscodingMaxAudioChannels=2&VideoBitrate=8000000&AudioBitrate=192000`
      : `${session.client.baseUrl}/emby/Videos/${encodeURIComponent(itemId)}/stream?static=true&api_key=${session.token}`;

    await proxyHttpUpstream(req, res, {
      url: upstreamUrl,
      headers: { extra: { 'X-Emby-Token': session.token, Referer: session.client.baseUrl } },
      cors: 'wildcard',
      defaultContentType: audioTranscode ? 'application/x-mpegURL' : 'video/mp4',
      // 转码冷启动：Jellyfin 需先启动 ffmpeg 转码才吐出首个分片，30s 默认超时会误杀
      timeoutMs: audioTranscode ? 90_000 : undefined,
      logTag: audioTranscode ? 'jellyfin-stream-transcode' : 'jellyfin-stream',
      errorMessage: 'Jellyfin 视频流代理失败',
    });
  } catch (err) {
    console.error('[jellyfin] stream error:', err);
    if (!res.headersSent) {
      const status = extractErrorCode(err) === 'AUTH_FAILED' ? 401 : 502;
      res.status(status).json({ success: false, message: extractErrorMessage(err, 'Jellyfin 视频流代理失败'), code: extractErrorCode(err) });
    } else {
      res.destroy();
    }
  }
});

export default router;