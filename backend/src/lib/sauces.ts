import { ProviderRunRecord } from './dataStore';

export type SauceSource = {
  key: string;
  label: string;
  count: number;
};

type ResultLike = {
  sourceUrl: string | null;
  sourceName: string | null;
  score: number | null;
  distance?: number | null;
};

export const normalizeSauceKey = (value: string) => value.trim().toLowerCase();

const ignoredSauceKeys = new Set(['saucenao', 'fluffle']);
const canonicalSauces: Record<string, string> = {
  'e621.net': 'e621',
  'www.e621.net': 'e621',
  'static1.e621.net': 'e621',
  'static2.e621.net': 'e621',
  'static3.e621.net': 'e621',
  'static4.e621.net': 'e621',
  'danbooru.donmai.us': 'danbooru',
  'www.danbooru.donmai.us': 'danbooru'
};

const canonicalizeSauceKey = (value: string) => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};
const targetScoreThresholds: Record<string, number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

const labelFromUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const normalizeSourceName = (value: string) => {
  let cleaned = value.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^index\s*#?\d+:\s*/i, '');
  cleaned = cleaned.replace(/\s+–\s+/g, ' - ');
  if (cleaned.includes(' - ')) {
    cleaned = cleaned.split(' - ')[0].trim();
  }
  return cleaned;
};

const looksLikeFilename = (value: string) => {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.includes('/') || lower.includes('\\')) return true;
  return /\.[a-z0-9]{2,5}$/.test(lower);
};

export const extractSauceKey = (sourceUrl: string | null, sourceName: string | null) => {
  if (sourceName) {
    const cleaned = normalizeSourceName(sourceName);
    if (cleaned && !looksLikeFilename(cleaned)) {
      const key = canonicalizeSauceKey(cleaned);
      if (!ignoredSauceKeys.has(key)) return key;
    }
  }
  if (sourceUrl) {
    try {
      const key = canonicalizeSauceKey(new URL(sourceUrl).hostname.replace(/^www\./, ''));
      if (ignoredSauceKeys.has(key)) return null;
      return key;
    } catch {
      const key = canonicalizeSauceKey(sourceUrl);
      if (ignoredSauceKeys.has(key)) return null;
      return key;
    }
  }
  return null;
};

export const extractSauceLabel = (sourceUrl: string | null, sourceName: string | null) => {
  if (sourceName) {
    const cleaned = normalizeSourceName(sourceName);
    if (cleaned && !looksLikeFilename(cleaned)) {
      const key = canonicalizeSauceKey(cleaned);
      return key === cleaned ? cleaned : key;
    }
  }
  if (sourceUrl) {
    const label = labelFromUrl(sourceUrl);
    const key = canonicalizeSauceKey(label);
    return key === label ? label : key;
  }
  return '';
};

const resultsFromRun = (run: ProviderRunRecord): ResultLike[] => {
  if (Array.isArray(run.results) && run.results.length) {
    return run.results.map((result) => ({
      sourceUrl: result.sourceUrl ?? null,
      sourceName: result.sourceName ?? null,
      score: typeof result.score === 'number' ? result.score : null,
      distance: typeof result.distance === 'number' ? result.distance : null
    }));
  }
  if (run.sourceUrl) {
    return [
      {
        sourceUrl: run.sourceUrl ?? null,
        sourceName: null,
        score: typeof run.score === 'number' ? run.score : null
      }
    ];
  }
  return [];
};

const resolveResultScore = (run: ProviderRunRecord, result: ResultLike) => {
  let score = result.score;
  if (run.provider === 'FLUFFLE' && score === null) {
    score = typeof result.distance === 'number' ? result.distance : null;
  }
  return score;
};

export const collectSaucesFromRuns = (runs: ProviderRunRecord[]): SauceSource[] => {
  const perSourceFiles = new Map<string, { label: string; files: Set<string> }>();

  for (const run of runs) {
    if (run.status !== 'COMPLETED') continue;
    const threshold = targetScoreThresholds[run.provider] ?? 0;
    const bestByKey = new Map<string, { label: string; score: number }>();
    for (const result of resultsFromRun(run)) {
      const score = resolveResultScore(run, result);
      if (score === null || score < threshold) continue;
      const key = extractSauceKey(result.sourceUrl, result.sourceName);
      if (!key) continue;
      const label = extractSauceLabel(result.sourceUrl, result.sourceName) || key;
      const existing = bestByKey.get(key);
      if (!existing || score > existing.score) {
        bestByKey.set(key, { label, score });
      }
    }
    for (const [key, value] of bestByKey.entries()) {
      const existing = perSourceFiles.get(key);
      if (existing) {
        existing.files.add(run.fileId);
      } else {
        perSourceFiles.set(key, { label: value.label, files: new Set([run.fileId]) });
      }
    }
  }

  return Array.from(perSourceFiles.entries())
    .map(([key, value]) => ({ key, label: value.label, count: value.files.size }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
};

export const hasTargetSauce = (runs: ProviderRunRecord[], targetKeys: Set<string>) => {
  if (targetKeys.size === 0) return false;
  for (const run of runs) {
    if (run.status === 'PENDING' || run.status === 'RUNNING') continue;
    const threshold = targetScoreThresholds[run.provider] ?? 0;
    for (const result of resultsFromRun(run)) {
      let score = result.score;
      if (run.provider === 'FLUFFLE' && score === null) {
        score = result.distance ?? null;
      }
      if (score === null || score < threshold) continue;
      const key = extractSauceKey(result.sourceUrl, result.sourceName);
      if (key && targetKeys.has(key)) return true;
    }
  }
  return false;
};
