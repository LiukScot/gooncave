import {
  FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { z } from 'zod';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { settingsRepo } from '../db/repos/settingsRepo';
import {
  engineCredentialError,
  getEngine
} from '../lib/booruEngines';
import { normalizeTag } from '../lib/booruEngines/helpers';
import { resetSubscriptionFeed } from '../services/subscriptionFeed';

const extraSettingsSchema = z.object({
  gamesTabEnabled: z.boolean().optional(),
  voteSystemEnabled: z.boolean().optional(),
  autoVoteOnFavorite: z.boolean().optional()
});

// Values are `KeyboardEvent.key` strings. Bounded on all three axes — key
// length, value length and entry count — so the settings row cannot become
// a place to park arbitrary data.
const MAX_SHORTCUT_BINDINGS = 64;

const shortcutsSchema = z.object({
  bindings: z
    .record(z.string().min(1).max(32), z.string().min(1).max(32))
    .refine(
      (bindings) => Object.keys(bindings).length <= MAX_SHORTCUT_BINDINGS,
      { message: `At most ${MAX_SHORTCUT_BINDINGS} bindings` }
    )
});

// Bounded like the shortcuts blob: the settings row is not a place to park
// arbitrary data.
const MAX_BLACKLIST_TAGS = 500;

const blacklistSchema = z.object({
  tags: z.array(z.string().min(1).max(100)).max(MAX_BLACKLIST_TAGS).optional(),
  applyToExplore: z.boolean().optional(),
  applyToGallery: z.boolean().optional()
});

const subscriptionTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(100))
});

const artistSubscriptionSchema = z.object({
  siteId: z.string().min(1),
  artist: z.string().trim().min(1).max(50)
});

const subscriptionTagSchema = z.object({
  tag: z.string().trim().min(1).max(100)
});

// The subscriptions page reads the artist list off every site that has one,
// and each change re-reads the site and drops the indexed feed; both reach
// booru sites that challenge callers who come back too often.
const subscriptionsReadRateLimit = { max: 20, timeWindow: '1 minute' };
const subscriptionsWriteRateLimit = { max: 30, timeWindow: '1 minute' };

export const registerSettingsRoutes = (app: FastifyInstance) => {
  app.get('/settings/subscriptions/tags', async (request) => ({
    tags: settingsRepo.getSubscriptionTags(request.currentUser!.id)
  }));

  app.get(
    '/settings/subscriptions',
    { config: { rateLimit: subscriptionsReadRateLimit } },
    async (request) => {
      const userId = request.currentUser!.id;
      const sites = (await booruSitesRepo.listBooruSites(userId)).filter(
        (site) => site.enabled && Boolean(getEngine(site.engine)?.listArtistSubscriptions)
      );
      const settled = await Promise.allSettled(
        sites.map(async (site) => {
          const credentialError = engineCredentialError(site);
          if (credentialError) throw new Error(credentialError);
          return getEngine(site.engine)!.listArtistSubscriptions!(site);
        })
      );
      const tags = settingsRepo.getSubscriptionTags(userId);
      const artistSources = sites.map((site, index) => {
        const result = settled[index];
        return {
          siteId: site.id,
          siteName: site.name,
          artists: result.status === 'fulfilled' ? result.value : [],
          error:
            result.status === 'rejected' ? (result.reason as Error).message : null
        };
      });
      return {
        tags,
        artistSources,
        targets: [
          ...tags.map((value) => ({ kind: 'tag' as const, value })),
          ...artistSources.flatMap((source) =>
            source.artists.map((value) => ({ kind: 'artist' as const, value }))
          )
        ]
      };
    }
  );

  app.put(
    '/settings/subscriptions/tags',
    { config: { rateLimit: subscriptionsWriteRateLimit } },
    async (request, reply) => {
      const parsed = subscriptionTagsSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      const tags = Array.from(
        new Set(parsed.data.tags.map(normalizeTag).filter(Boolean))
      );
      const previous = settingsRepo.getSubscriptionTags(request.currentUser!.id);
      const saved = settingsRepo.saveSubscriptionTags(
        request.currentUser!.id,
        tags
      );
      if (JSON.stringify(previous) !== JSON.stringify(tags)) {
        await resetSubscriptionFeed(request.currentUser!.id);
      }
      return { tags: saved };
    }
  );

  app.post(
    '/settings/subscriptions/tags',
    { config: { rateLimit: subscriptionsWriteRateLimit } },
    async (request, reply) => {
      const parsed = subscriptionTagSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      const tag = normalizeTag(parsed.data.tag);
      const previous = settingsRepo.getSubscriptionTags(request.currentUser!.id);
      const tags = Array.from(new Set([...previous, tag])).filter(Boolean);
      const saved = settingsRepo.saveSubscriptionTags(
        request.currentUser!.id,
        tags
      );
      if (!previous.includes(tag)) {
        await resetSubscriptionFeed(request.currentUser!.id);
      }
      return { tags: saved };
    }
  );

  const updateArtist = async (
    request: FastifyRequest,
    reply: FastifyReply,
    subscribed: boolean
  ) => {
    const parsed = artistSubscriptionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const site = await booruSitesRepo.getBooruSite(
      parsed.data.siteId,
      request.currentUser!.id
    );
    if (!site) {
      reply.code(404);
      return { error: 'Site not found' };
    }
    const engine = getEngine(site.engine);
    const action = subscribed
      ? engine?.subscribeArtist
      : engine?.unsubscribeArtist;
    if (!action) {
      reply.code(400);
      return { error: `${site.name} does not support artist subscriptions` };
    }
    const credentialError = engineCredentialError(site);
    if (credentialError) {
      reply.code(400);
      return { error: credentialError };
    }
    await action(site, parsed.data.artist);
    await resetSubscriptionFeed(request.currentUser!.id);
    return { ok: true };
  };

  app.post(
    '/settings/subscriptions/artists',
    { config: { rateLimit: subscriptionsWriteRateLimit } },
    async (request, reply) => updateArtist(request, reply, true)
  );

  app.delete(
    '/settings/subscriptions/artists',
    { config: { rateLimit: subscriptionsWriteRateLimit } },
    async (request, reply) => updateArtist(request, reply, false)
  );

  app.get('/settings/shortcuts', async (request) => ({
    bindings: settingsRepo.getShortcuts(request.currentUser!.id)
  }));

  app.put('/settings/shortcuts', async (request, reply) => {
    const parsed = shortcutsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return {
      bindings: settingsRepo.saveShortcuts(
        request.currentUser!.id,
        parsed.data.bindings
      )
    };
  });

  app.get('/settings/extra', async (request) =>
    settingsRepo.getExtraSettings(request.currentUser!.id)
  );

  app.put('/settings/extra', async (request, reply) => {
    const parsed = extraSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return settingsRepo.saveExtraSettings(parsed.data, request.currentUser!.id);
  });

  app.get('/settings/blacklist', async (request) =>
    settingsRepo.getBlacklist(request.currentUser!.id)
  );

  app.put('/settings/blacklist', async (request, reply) => {
    const parsed = blacklistSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const { tags, ...rest } = parsed.data;
    // Stored the same shape the tag columns hold, so a pasted list matches
    // whatever spelling the user typed it in.
    const normalized = tags
      ? Array.from(new Set(tags.map(normalizeTag).filter(Boolean)))
      : undefined;
    return settingsRepo.saveBlacklist(
      normalized ? { ...rest, tags: normalized } : rest,
      request.currentUser!.id
    );
  });
};
