import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { config } from '../config';

import * as schema from './schema';

const dataFile = config.storage.dataFile ?? 'storage/data.db';

if (dataFile !== ':memory:') {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
}

export const sqlite = new BetterSqlite3(dataFile);

sqlite.function('stable_hash', { deterministic: true }, (seed: unknown, value: unknown) =>
  createHash('sha1').update(`${seed ?? ''}:${value ?? ''}`).digest('hex')
);

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 30000');
sqlite.pragma('cache_size = -32000');
sqlite.pragma('mmap_size = 30000000');

export const db = drizzle(sqlite, { schema });
