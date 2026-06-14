import type { ProviderRunRecord } from '../db/types';

type Provider = ProviderRunRecord['provider'];

// Minimum match score for a reverse-image provider result to be trusted as a
// real source: used to gate auto-favorite (favorites.ts), tag import
// (tagging.ts) and the Sources aggregation (sauces.ts). SauceNAO scores are a
// 0-100 confidence; Fluffle is stricter so it needs a higher bar. Single
// source of truth — keep all three callers reading from here (issue #200
// finding 4).
export const PROVIDER_MATCH_THRESHOLDS: Record<Provider, number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

export const providerMatchThreshold = (provider: Provider): number =>
  PROVIDER_MATCH_THRESHOLDS[provider] ?? 0;
