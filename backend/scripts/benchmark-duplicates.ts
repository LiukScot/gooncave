import { spawnSync } from 'node:child_process';

type Mode = 'baseline' | 'optimized';

const runChild = async (mode: Mode, count: number) => {
  process.env.DATA_FILE = ':memory:';
  const [
    { sqlite },
    { runMigrations },
    { filesRepo },
    { favoritesRepo },
    { findDuplicates }
  ] = await Promise.all([
    import('../src/db/client'),
    import('../src/db/migrate'),
    import('../src/db/repos/filesRepo'),
    import('../src/db/repos/favoritesRepo'),
    import('../src/lib/duplicates')
  ]);
  runMigrations();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      'INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run('benchmark-user', 'benchmark', 'unused', '/benchmark', now, now);
  sqlite
    .prepare(
      'INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      'benchmark-folder',
      'benchmark-user',
      '/benchmark',
      'LOCAL',
      now,
      now,
      'IDLE'
    );
  const insert = sqlite.prepare(
    `INSERT INTO files
      (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, width, height, created_at, updated_at)
     VALUES (?, 'benchmark-folder', 'LOCAL', ?, 1, ?, ?, 'IMAGE', ?, ?, ?, ?)`
  );
  sqlite.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `file-${index}`,
        `/benchmark/${index}.png`,
        now,
        `sha-${index}`,
        index + 1,
        index + 2,
        now,
        now
      );
    }
  })();

  Bun.gc(true);
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  let groupCount: number;
  if (mode === 'baseline') {
    const files = await filesRepo.listFiles(undefined, 'benchmark-user');
    await favoritesRepo.listFavoriteItems(undefined, 'benchmark-user');
    const groups = new Map<string, number>();
    for (const file of files) {
      const key = `${file.mediaType}:${file.width}x${file.height}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    groupCount = Array.from(groups.values()).filter((size) => size >= 2).length;
  } else {
    const result = await findDuplicates('benchmark-user');
    groupCount = result.groups.length;
  }
  const elapsedMs = performance.now() - started;
  const rssDeltaMiB = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
  process.stdout.write(
    `${JSON.stringify({ mode, count, elapsedMs, rssDeltaMiB, groupCount })}\n`
  );
};

const main = async () => {
  const childMode = process.argv[2] as Mode | undefined;
  const childCount = Number(process.argv[3]);
  if (childMode && Number.isFinite(childCount)) {
    await runChild(childMode, childCount);
    return;
  }

  const results = [];
  for (const count of [1_000, 50_000]) {
    for (const mode of ['baseline', 'optimized'] as const) {
      const child = spawnSync(
        process.execPath,
        [__filename, mode, String(count)],
        { encoding: 'utf8' }
      );
      if (child.status !== 0) throw new Error(child.stderr || child.stdout);
      results.push(JSON.parse(child.stdout.trim().split('\n').at(-1)!));
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        contract: {
          datasets: 'eligible images with unique dimensions and no duplicate groups',
          baseline: 'load all files and favorites, then group in JavaScript',
          optimized: 'group candidates in SQLite, then run the public scan'
        },
        results
      },
      null,
      2
    )}\n`
  );
};

// CLI entry point: report failures and make the benchmark fail in automation.
void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
