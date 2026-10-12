import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from '../config';

export const DIAGNOSTIC_SLOW_MS = 4_000;
const MAX_REPORTS = 200;
const MAX_BYTES = 512 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const GROUP_MS = 10 * 60 * 1000;
const attemptSchema = z.object({
  provider: z.string().max(40),
  status: z.number().int().nullable(),
  elapsedMs: z.number().nonnegative(),
  outcome: z.enum(['pending', 'response', 'network-error'])
});
const reportSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().max(200),
  operation: z.enum(['search', 'detail', 'favorite', 'provider-action']),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  elapsedMs: z.number().nonnegative(),
  outcome: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  count: z.number().int().positive(),
  providers: z.array(z.string().max(40)).max(24),
  attempts: z.array(attemptSchema).max(24),
  requestCount: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  challenges: z.number().int().nonnegative(),
  rateLimits: z.number().int().nonnegative(),
  sharedWaitMs: z.number().nonnegative()
});
type Report = z.infer<typeof reportSchema>;
type Context = {
  report: Report;
  started: number;
  active: boolean;
  waits: Set<{ started: number }>;
};
const context = new AsyncLocalStorage<Context>();
const filePath = () =>
  path.join(path.dirname(config.storage.dataFile), 'provider-diagnostics.json');
let writes: Promise<void> = Promise.resolve();
let storageFailed = false;
const pendingReports = new Map<string, Report>();
let draining = false;

async function persist(reports: Report[]): Promise<void> {
  await mkdir(path.dirname(filePath()), { recursive: true });
  const temporary = `${filePath()}.tmp`;
  await writeFile(temporary, JSON.stringify(reports), { mode: 0o600 });
  await rename(temporary, filePath());
  storageFailed = false;
}

function storageError(): void {
  storageFailed = true;
  // Do not log filesystem errors: their paths may contain account names.
  console.error(
    '[provider-diagnostics] Unable to save report; check storage permissions and free space'
  );
}

async function readReports(): Promise<Report[]> {
  try {
    if ((await stat(filePath())).size > MAX_BYTES)
      throw new Error('Diagnostic file exceeds its size limit');
    const reports = z
      .array(reportSchema)
      .max(MAX_REPORTS)
      .parse(JSON.parse(await readFile(filePath(), 'utf8')));
    return reports.filter(
      (report) => Date.now() - Date.parse(report.updatedAt) < RETENTION_MS
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
}

function save(report: Report): void {
  pendingReports.set(report.id, structuredClone(report));
  if (pendingReports.size > MAX_REPORTS)
    pendingReports.delete(pendingReports.keys().next().value!);
  if (draining) return;
  draining = true;
  writes = writes
    .then(async () => {
      while (pendingReports.size) {
        const snapshot = pendingReports.values().next().value!;
        pendingReports.delete(snapshot.id);
        const reports = await readReports();
        const existing = reports.findIndex((item) => item.id === snapshot.id);
        if (existing >= 0) reports.splice(existing, 1);
        if (snapshot.outcome !== 'pending') {
          const signature = (item: Report) =>
            JSON.stringify([
              item.userId,
              item.operation,
              item.outcome,
              item.providers,
              item.attempts.map((attempt) => [
                attempt.provider,
                attempt.status,
                attempt.outcome
              ])
            ]);
          const grouped = reports.findIndex(
            (item) =>
              item.outcome !== 'pending' &&
              Date.parse(snapshot.updatedAt) - Date.parse(item.updatedAt) <
                GROUP_MS &&
              signature(item) === signature(snapshot)
          );
          if (grouped >= 0)
            snapshot.count += reports.splice(grouped, 1)[0].count;
        }
        reports.push(snapshot);
        while (
          reports.length > MAX_REPORTS ||
          Buffer.byteLength(JSON.stringify(reports)) > MAX_BYTES
        )
          reports.shift();
        await persist(reports);
      }
    })
    .catch(() => {
      pendingReports.clear();
      storageError();
    })
    .finally(() => {
      draining = false;
      const next = pendingReports.values().next().value;
      if (next) save(next);
    });
}

export async function listProviderDiagnostics(userId: string) {
  do { await writes; } while (draining);
  if (storageFailed) throw new Error('Diagnostic storage is unavailable');
  return (await readReports())
    .filter((report) => report.userId === userId)
    .reverse()
    .map((report) => reportSchema.omit({ userId: true }).parse(report));
}

export function diagnosticRefusal(
  challenge: boolean,
  rateLimited: boolean
): void {
  const current = context.getStore();
  if (!current?.active) return;
  current.report.challenges += Number(challenge);
  current.report.rateLimits += Number(rateLimited);
}

export function diagnosticRetry(): void {
  const current = context.getStore();
  if (current?.active) current.report.retries += 1;
}

function providerName(url: string): string {
  const host = new URL(url).hostname;
  const known = [
    'rule34.xxx',
    'e621.net',
    'e926.net',
    'danbooru.donmai.us',
    'gelbooru.com',
    'furaffinity.net',
    'yande.re',
    'konachan.com',
    'derpibooru.org',
    'sankakucomplex.com'
  ];
  return (
    known.find((name) => host === name || host.endsWith(`.${name}`)) ??
    'custom provider'
  );
}

function noteProvider(current: Context, url: string): string {
  const provider = providerName(url);
  if (!current.report.providers.includes(provider))
    current.report.providers.push(provider);
  return provider;
}

export function diagnosticWait(url: string): () => void {
  const current = context.getStore();
  if (!current?.active) return () => undefined;
  noteProvider(current, url);
  const waiting = { started: Date.now() };
  current.waits.add(waiting);
  return () => {
    current.waits.delete(waiting);
    current.report.sharedWaitMs += Date.now() - waiting.started;
  };
}

export function diagnosticFetch(url: string): (status: number | null) => void {
  const current = context.getStore();
  if (!current?.active) return () => undefined;
  const provider = noteProvider(current, url);
  const attempt: z.infer<typeof attemptSchema> = {
    provider,
    status: null,
    elapsedMs: 0,
    outcome: 'pending'
  };
  current.report.requestCount += 1;
  current.report.attempts.push(attempt);
  if (current.report.attempts.length > 24) current.report.attempts.shift();
  const started = Date.now();
  return (status) => {
    attempt.status = status;
    attempt.elapsedMs = Date.now() - started;
    attempt.outcome = status === null ? 'network-error' : 'response';
  };
}

export function registerProviderDiagnostics(
  app: FastifyInstance,
  isEnabled: (userId: string) => boolean,
  slowMs = DIAGNOSTIC_SLOW_MS
): void {
  const active = new Map<
    FastifyRequest,
    {
      context: Context;
      timer: ReturnType<typeof setTimeout>;
      detach: () => void;
    }
  >();
  const update = (current: Context, outcome: Report['outcome']) => {
    if (!isEnabled(current.report.userId)) return;
    current.report.elapsedMs = Date.now() - current.started;
    current.report.updatedAt = new Date().toISOString();
    current.report.outcome = outcome;
    const waitedMs = Array.from(current.waits).reduce(
      (sum, wait) => sum + Date.now() - wait.started,
      0
    );
    if (
      (current.report.requestCount || current.waits.size) &&
      (current.report.elapsedMs >= slowMs ||
        outcome === 'failed' ||
        current.report.retries ||
        current.report.attempts.some(
          (item) => item.status === null || item.status >= 400
        ))
    )
      save({
        ...current.report,
        sharedWaitMs: current.report.sharedWaitMs + waitedMs
      });
  };
  const finish = (request: FastifyRequest, outcome: Report['outcome']) => {
    const entry = active.get(request);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.detach();
    update(entry.context, outcome);
    entry.context.active = false;
    active.delete(request);
  };
  app.addHook('preHandler', (request, reply, done) => {
    const route = request.routeOptions.url ?? '';
    if (
      !request.currentUser ||
      !/^\/(explore|favorites|booru-sites|settings\/subscriptions)(\/|$)/.test(route) ||
      !isEnabled(request.currentUser.id)
    )
      return done();
    const operation: Report['operation'] =
      route === '/explore/posts'
        ? 'search'
        : /favorite/.test(route)
          ? 'favorite'
          : route.startsWith('/explore/') && request.method === 'GET'
            ? 'detail'
            : 'provider-action';
    const started = Date.now();
    const current: Context = {
      started,
      active: true,
      waits: new Set(),
      report: {
        id: randomUUID(),
        userId: request.currentUser.id,
        operation,
        startedAt: new Date(started).toISOString(),
        updatedAt: new Date(started).toISOString(),
        elapsedMs: 0,
        outcome: 'pending',
        count: 1,
        providers: [],
        attempts: [],
        requestCount: 0,
        retries: 0,
        challenges: 0,
        rateLimits: 0,
        sharedWaitMs: 0
      }
    };
    const timer = setTimeout(() => update(current, 'pending'), slowMs);
    timer.unref();
    const disconnected = () => {
      if (!reply.raw.writableFinished) finish(request, 'cancelled');
    };
    reply.raw.once('close', disconnected);
    active.set(request, {
      context: current,
      timer,
      detach: () => reply.raw.removeListener('close', disconnected)
    });
    context.run(current, done);
  });
  app.addHook('onResponse', async (request, reply) =>
    finish(request, reply.statusCode >= 400 ? 'failed' : 'completed')
  );
  app.addHook('onTimeout', async (request) => finish(request, 'failed'));
  app.addHook('onRequestAbort', async (request) =>
    finish(request, 'cancelled')
  );
  const maintenance = setInterval(
    () => {
      writes = writes
        .then(async () => persist(await readReports()))
        .catch(storageError);
    },
    60 * 60 * 1000
  );
  maintenance.unref();
  app.addHook('onClose', async () => {
    clearInterval(maintenance);
    for (const request of active.keys()) finish(request, 'cancelled');
    await writes;
  });
}
