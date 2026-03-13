import path from 'path';
import { appendFile } from 'fs/promises';

import { FileRecord, ProviderRunRecord, dataStore } from './dataStore';
import { runFluffle, runSauceNao } from '../services/providers';
import { refreshTagsFromProviderRun } from '../services/tagging';

export type ProviderKind = 'SAUCENAO' | 'FLUFFLE';

const logFile = path.resolve(process.cwd(), 'log.txt');
const providerRunLimit = 100;
const providerRunWindowMs = 24 * 60 * 60 * 1000;
const logLine = async (line: string) => {
  const ts = new Date().toISOString();
  await appendFile(logFile, `[${ts}] ${line}\n`);
};

export const executeProviderRun = async (
  file: FileRecord,
  provider: ProviderKind
): Promise<{ providerRun: ProviderRunRecord | null; error?: string; rateLimited?: boolean; retryAt?: string | null }> => {
  const limitResult = await dataStore.createProviderRunWithLimit(
    file.id,
    provider,
    providerRunLimit,
    providerRunWindowMs
  );
  if (!limitResult.run) {
    const retryAt = limitResult.retryAt;
    const message = `Rate limit reached for ${provider}. Try again after ${retryAt ?? 'later'}.`;
    return { providerRun: null, error: message, rateLimited: true, retryAt };
  }
  const run = limitResult.run;
  await dataStore.updateProviderRun(run.id, { status: 'RUNNING' });
  try {
    const result = provider === 'SAUCENAO' ? await runSauceNao(file) : await runFluffle(file);

    if (result.error) {
      await logLine(`[provider:${provider}] failed for file ${file.id}: ${result.error}`);
      const updated = await dataStore.updateProviderRun(run.id, {
        status: 'FAILED',
        error: result.error,
        completedAt: new Date().toISOString()
      });
      return { providerRun: updated, error: result.error };
    }

    const updated = await dataStore.updateProviderRun(run.id, {
      status: 'COMPLETED',
      cachedHit: false,
      score: result.score,
      sourceUrl: result.sourceUrl,
      thumbUrl: result.thumbUrl,
      results: result.results ?? [],
      completedAt: new Date().toISOString(),
      error: null
    });

    if (provider === 'FLUFFLE' && result.debug) {
      const message = `[provider:FLUFFLE] rawScore=${result.debug.rawScore ?? 'n/a'} rawDistance=${
        result.debug.rawDistance ?? 'n/a'
      } similarity=${result.debug.similarity ?? 'n/a'} derivedScore=${result.score ?? 'n/a'} source=${
        result.sourceUrl ?? 'n/a'
      }`;
      await logLine(message);
      console.log(message);
    }

    if (updated) {
      await refreshTagsFromProviderRun(file, updated);
    }

    await logLine(
      `[provider:${provider}] completed for file ${file.id} source=${result.sourceUrl ?? 'n/a'} score=${
        result.score ?? 'n/a'
      }`
    );

    return { providerRun: updated };
  } catch (err) {
    const message = (err as Error).message;
    await logLine(`[provider:${provider}] error for file ${file.id}: ${message}`);
    const updated = await dataStore.updateProviderRun(run.id, {
      status: 'FAILED',
      error: message,
      completedAt: new Date().toISOString()
    });
    return { providerRun: updated, error: message };
  }
};
