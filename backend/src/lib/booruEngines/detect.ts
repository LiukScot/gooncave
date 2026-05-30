import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruEngineType } from '../../db/types';

import { safeJoin, stripTrailingSlash } from './helpers';
import type { ProbeSample } from './types';

import { ENGINE_REGISTRY } from './index';

export type DetectionAttemptStatus =
  | 'matched'
  | 'no-match'
  | 'http-error'
  | 'network-error'
  | 'timeout';

export type DetectionAttempt = {
  engine: BooruEngineType;
  status: DetectionAttemptStatus;
  httpStatus?: number;
  error?: string;
};

export type DetectionResult = {
  engine: BooruEngineType;
  confidence: 'hostname' | 'probe';
  sample: ProbeSample | null;
  attempts: DetectionAttempt[];
};

export type DetectionFailure =
  | { error: 'unknown'; tried: BooruEngineType[]; attempts: DetectionAttempt[] }
  | { error: 'unreachable'; message: string; attempts: DetectionAttempt[] };

const HOSTNAME_MAP: Array<{ pattern: RegExp; engine: BooruEngineType }> = [
  { pattern: /(^|\.)e621\.net$/i, engine: 'e621' },
  { pattern: /(^|\.)e926\.net$/i, engine: 'e621' },
  { pattern: /(^|\.)donmai\.us$/i, engine: 'danbooru' },
  { pattern: /^gelbooru\.com$/i, engine: 'gelbooru' },
  { pattern: /^rule34\.xxx$/i, engine: 'gelbooru' },
  { pattern: /^safebooru\.org$/i, engine: 'gelbooru' },
  { pattern: /^realbooru\.com$/i, engine: 'gelbooru' },
  { pattern: /^tbib\.org$/i, engine: 'gelbooru' },
  { pattern: /^yande\.re$/i, engine: 'moebooru' },
  { pattern: /^konachan\.(com|net)$/i, engine: 'moebooru' },
  { pattern: /(^|\.)sankakucomplex\.com$/i, engine: 'sankaku' },
  { pattern: /^derpibooru\.org$/i, engine: 'philomena' },
  { pattern: /^ponybooru\.org$/i, engine: 'philomena' },
  { pattern: /^twibooru\.org$/i, engine: 'philomena' },
  { pattern: /^rule34\.paheal\.net$/i, engine: 'shimmie' }
];

// Probe race ordering: more-specific shapes first so we don't accidentally
// classify an e621 response as danbooru (both share /posts.json but the
// shape differs). Shimmie probes XML, so it's well-isolated from the JSON
// engines and order is not critical for it; szurubooru returns a distinct
// envelope shape and is also unambiguous.
const PROBE_ORDER: BooruEngineType[] = [
  'e621',
  'danbooru',
  'philomena',
  'moebooru',
  'gelbooru',
  'sankaku',
  'szurubooru',
  'shimmie'
];

const PROBE_TIMEOUT_MS = 4000;

const hostnameLookup = (baseUrl: string): BooruEngineType | null => {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
  for (const entry of HOSTNAME_MAP) {
    if (entry.pattern.test(host)) return entry.engine;
  }
  return null;
};

const fetchWithTimeout = async (url: string, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': config.e621.userAgent,
        Accept: 'application/json, application/xml;q=0.8, */*;q=0.5'
      },
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
};

type ProbeOutcome =
  | { result: 'matched'; sample: ProbeSample | null; httpStatus: number }
  | { result: 'no-match'; httpStatus: number }
  | { result: 'http-error'; httpStatus: number; error?: string }
  | { result: 'network-error'; error: string }
  | { result: 'timeout' };

const probeEngine = async (baseUrl: string, engine: BooruEngineType): Promise<ProbeOutcome> => {
  const module = ENGINE_REGISTRY[engine];
  const url = safeJoin(baseUrl, module.probePath);
  let res;
  try {
    res = await fetchWithTimeout(url, PROBE_TIMEOUT_MS);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('aborted')) return { result: 'timeout' };
    return { result: 'network-error', error: msg };
  }
  if (!res.ok) {
    return { result: 'http-error', httpStatus: res.status, error: `HTTP ${res.status}` };
  }
  const text = await res.text();
  // Try JSON first, fall back to raw text for XML-based engines (shimmie).
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON — keep `body = text` so XML-shaped engines can match
  }
  if (!module.probeMatches(body)) {
    return { result: 'no-match', httpStatus: res.status };
  }
  const sample = module.probeSample ? module.probeSample(body) : null;
  return { result: 'matched', sample, httpStatus: res.status };
};

const outcomeToAttempt = (engine: BooruEngineType, outcome: ProbeOutcome): DetectionAttempt => {
  switch (outcome.result) {
    case 'matched':
      return { engine, status: 'matched', httpStatus: outcome.httpStatus };
    case 'no-match':
      return { engine, status: 'no-match', httpStatus: outcome.httpStatus };
    case 'http-error':
      return { engine, status: 'http-error', httpStatus: outcome.httpStatus, error: outcome.error };
    case 'network-error':
      return { engine, status: 'network-error', error: outcome.error };
    case 'timeout':
      return { engine, status: 'timeout' };
  }
};

export const detectEngine = async (baseUrl: string): Promise<DetectionResult | DetectionFailure> => {
  const normalized = stripTrailingSlash(baseUrl);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { error: 'unknown', tried: [], attempts: [] };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'unknown', tried: [], attempts: [] };
  }

  const hostnameEngine = hostnameLookup(normalized);
  if (hostnameEngine) {
    // Still run the matched engine's probe so the caller gets a sample
    // thumbnail — hostname lookup alone has no proof-of-life.
    const outcome = await probeEngine(normalized, hostnameEngine);
    const attempts = [outcomeToAttempt(hostnameEngine, outcome)];
    const sample = outcome.result === 'matched' ? outcome.sample : null;
    return { engine: hostnameEngine, confidence: 'hostname', sample, attempts };
  }

  // Race every engine in parallel. Each settles to its own outcome, none
  // throw — outcomes are aggregated into the attempts log so the UI can
  // explain WHY a detection failed.
  const settled = await Promise.allSettled(PROBE_ORDER.map((engine) => probeEngine(normalized, engine)));

  const attempts: DetectionAttempt[] = settled.map((entry, idx) => {
    const engine = PROBE_ORDER[idx];
    if (entry.status === 'fulfilled') return outcomeToAttempt(engine, entry.value);
    return { engine, status: 'network-error', error: String(entry.reason ?? 'unknown error') };
  });

  // If every engine failed at the network level (no HTTP reply at all), the
  // site is genuinely unreachable, not just unidentified.
  const anyHttpResponse = attempts.some((attempt) =>
    attempt.status === 'matched' ||
      attempt.status === 'no-match' ||
      attempt.status === 'http-error'
  );
  if (!anyHttpResponse) {
    const firstNetworkError = attempts.find((a) => a.status === 'network-error' || a.status === 'timeout');
    return {
      error: 'unreachable',
      message: firstNetworkError?.error ?? `No response from ${normalized}`,
      attempts
    };
  }

  // Walk PROBE_ORDER (most-specific shape first) and return the first match.
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i];
    if (entry.status === 'fulfilled' && entry.value.result === 'matched') {
      const engine = PROBE_ORDER[i];
      return { engine, confidence: 'probe', sample: entry.value.sample, attempts };
    }
  }
  return { error: 'unknown', tried: PROBE_ORDER, attempts };
};
