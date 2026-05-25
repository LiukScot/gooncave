import { FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { z } from 'zod';

import { config } from '../config';
import { getEngine, listEngines } from '../lib/booruEngines';
import { detectEngine } from '../lib/booruEngines/detect';
import { BOORU_PRESETS } from '../lib/booruEngines/presets';
import { BooruEngineType, BooruSiteRecord, dataStore } from '../lib/dataStore';

const engineEnum = z.enum([
  'danbooru',
  'e621',
  'moebooru',
  'gelbooru',
  'sankaku',
  'philomena',
  'shimmie',
  'szurubooru'
]);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  engine: engineEnum,
  baseUrl: z.string().url(),
  username: z.string().optional().nullable(),
  apiKey: z.string().optional().nullable(),
  capFavorites: z.boolean().optional(),
  capTags: z.boolean().optional(),
  capSourceMatch: z.boolean().optional(),
  capSearch: z.boolean().optional(),
  enabled: z.boolean().optional()
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  username: z.string().nullable().optional(),
  apiKey: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  capFavorites: z.boolean().optional(),
  capTags: z.boolean().optional(),
  capSourceMatch: z.boolean().optional(),
  capSearch: z.boolean().optional(),
  // Only honoured for non-preset rows; presets ignore engine/baseUrl edits to
  // keep historical favorite_items rows pointing at the right canonical site.
  engine: engineEnum.optional(),
  baseUrl: z.string().url().optional()
});

const detectSchema = z.object({
  baseUrl: z.string().url()
});

const reorderSchema = z.object({
  orderedIds: z.array(z.string()).min(1)
});

const toPublic = (site: BooruSiteRecord) => ({
  id: site.id,
  name: site.name,
  engine: site.engine,
  baseUrl: site.baseUrl,
  username: site.username,
  hasApiKey: Boolean(site.apiKey),
  isPreset: site.isPreset,
  presetKey: site.presetKey,
  enabled: site.enabled,
  capFavorites: site.capFavorites,
  capTags: site.capTags,
  capSourceMatch: site.capSourceMatch,
  capSearch: site.capSearch,
  sortOrder: site.sortOrder,
  createdAt: site.createdAt,
  updatedAt: site.updatedAt,
  engineCredentialSchema: getEngine(site.engine)?.credentialSchema ?? 'none'
});

const trimOrUndefined = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const probeTestConnection = async (
  site: BooruSiteRecord
): Promise<{ ok: boolean; status?: number; error?: string }> => {
  const engine = getEngine(site.engine);
  if (!engine) return { ok: false, error: 'unknown engine' };
  const url = site.baseUrl.replace(/\/+$/, '') + engine.probePath;
  try {
    const headers: Record<string, string> = { 'User-Agent': config.e621.userAgent };
    let probeUrl = url;
    if (site.username && site.apiKey) {
      if (engine.credentialSchema === 'username+apikey') {
        const token = Buffer.from(`${site.username}:${site.apiKey}`).toString('base64');
        headers.Authorization = `Basic ${token}`;
      } else if (engine.credentialSchema === 'userid+apikey') {
        probeUrl += `&user_id=${encodeURIComponent(site.username)}&api_key=${encodeURIComponent(site.apiKey)}`;
      }
    }
    const res = await fetch(probeUrl, { headers });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    // Mirror detect.ts: try JSON, fall back to the raw text so XML-based
    // engines (shimmie) can still shape-match instead of always failing here.
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — keep raw text for XML engines
    }
    if (!engine.probeMatches(body)) {
      return { ok: false, status: res.status, error: 'response does not match engine shape' };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

export const registerBooruSiteRoutes = (app: FastifyInstance) => {
  app.get('/booru-sites', async (request) => {
    const sites = await dataStore.listBooruSites(request.currentUser!.id);
    return { sites: sites.map(toPublic) };
  });

  app.get('/booru-sites/engines', async () => ({
    engines: listEngines().map((engine) => ({
      type: engine.type,
      credentialSchema: engine.credentialSchema,
      defaultCapabilities: engine.defaultCapabilities
    })),
    presets: BOORU_PRESETS.map((preset) => ({
      key: preset.key,
      name: preset.name,
      engine: preset.engine,
      baseUrl: preset.baseUrl,
      defaultCapabilities: preset.defaultCapabilities
    }))
  }));

  app.post('/booru-sites/detect', async (request, reply) => {
    const parsed = detectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const baseUrl = parsed.data.baseUrl.replace(/\/+$/, '');
    const result = await detectEngine(baseUrl);
    if ('engine' in result) {
      const engine = getEngine(result.engine);
      // Materialise the sample's path into an absolute URL the browser can
      // use without knowing the engine's path conventions. Done here (not in
      // detect.ts) so the engine modules stay free of route-rendering logic.
      const sample = result.sample
        ? {
            postId: result.sample.postId,
            thumbUrl: result.sample.thumbUrl,
            postUrl: `${baseUrl}${result.sample.postPath}`
          }
        : null;
      return {
        engine: result.engine,
        confidence: result.confidence,
        credentialSchema: engine?.credentialSchema ?? 'none',
        defaultCapabilities: engine?.defaultCapabilities ?? null,
        sample,
        attempts: result.attempts
      };
    }
    if (result.error === 'unreachable') {
      reply.code(502);
    } else {
      reply.code(422);
    }
    return result;
  });

  app.post('/booru-sites', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const engine = getEngine(parsed.data.engine);
    if (!engine) {
      reply.code(400);
      return { error: `Unknown engine: ${parsed.data.engine}` };
    }
    const baseUrl = parsed.data.baseUrl.replace(/\/+$/, '');
    const existing = await dataStore.findBooruSiteByBaseUrl(baseUrl, userId);
    if (existing) {
      reply.code(409);
      return { error: 'A site with this base URL already exists for this account' };
    }
    const capDefaults = engine.defaultCapabilities;
    const site = await dataStore.insertBooruSite(
      {
        name: parsed.data.name,
        engine: parsed.data.engine,
        baseUrl,
        username: trimOrUndefined(parsed.data.username ?? undefined) ?? null,
        apiKey: trimOrUndefined(parsed.data.apiKey ?? undefined) ?? null,
        isPreset: false,
        presetKey: null,
        enabled: parsed.data.enabled ?? true,
        capFavorites: parsed.data.capFavorites ?? capDefaults.favorites,
        capTags: parsed.data.capTags ?? capDefaults.tags,
        capSourceMatch: parsed.data.capSourceMatch ?? capDefaults.sourceMatch,
        capSearch: parsed.data.capSearch ?? capDefaults.search
      },
      userId
    );
    return { site: toPublic(site) };
  });

  app.put<{ Params: { id: string } }>('/booru-sites/:id', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const existing = await dataStore.getBooruSite(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: 'Site not found' };
    }
    const updates = { ...parsed.data };
    if (existing.isPreset) {
      // Lock engine + base_url for preset rows so that historical favorite_items
      // rows keep referring to the same canonical site (see AGENTS.md §11).
      delete (updates as { engine?: BooruEngineType }).engine;
      delete (updates as { baseUrl?: string }).baseUrl;
    } else if (updates.baseUrl) {
      updates.baseUrl = updates.baseUrl.replace(/\/+$/, '');
    }
    if (updates.username !== undefined) {
      updates.username = trimOrUndefined(updates.username);
    }
    if (updates.apiKey !== undefined) {
      updates.apiKey = trimOrUndefined(updates.apiKey);
    }
    const site = await dataStore.updateBooruSite(request.params.id, updates, userId);
    if (!site) {
      reply.code(404);
      return { error: 'Site not found' };
    }
    return { site: toPublic(site) };
  });

  app.delete<{ Params: { id: string } }>('/booru-sites/:id', async (request, reply) => {
    const userId = request.currentUser!.id;
    const existing = await dataStore.getBooruSite(request.params.id, userId);
    if (!existing) {
      reply.code(404);
      return { error: 'Site not found' };
    }
    if (existing.isPreset) {
      reply.code(400);
      return { error: 'Preset sites cannot be deleted. Disable the site instead.' };
    }
    const removed = await dataStore.deleteBooruSite(request.params.id, userId);
    if (!removed) {
      reply.code(409);
      return { error: 'Site could not be deleted' };
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/booru-sites/:id/test', async (request, reply) => {
    const userId = request.currentUser!.id;
    const site = await dataStore.getBooruSite(request.params.id, userId);
    if (!site) {
      reply.code(404);
      return { error: 'Site not found' };
    }
    const result = await probeTestConnection(site);
    return result;
  });

  app.post('/booru-sites/reorder', async (request, reply) => {
    const parsed = reorderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    await dataStore.reorderBooruSites(parsed.data.orderedIds, request.currentUser!.id);
    const sites = await dataStore.listBooruSites(request.currentUser!.id);
    return { sites: sites.map(toPublic) };
  });
};
