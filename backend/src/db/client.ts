import fs from 'fs';
import path from 'path';

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';

import { config } from '../config';

import * as schema from './schema';

const dataFile = config.storage.dataFile ?? 'storage/data.db';

if (dataFile !== ':memory:') {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
}

export const sqlite = new Database(dataFile);

sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA synchronous = NORMAL');
sqlite.exec('PRAGMA foreign_keys = ON');
sqlite.exec('PRAGMA busy_timeout = 30000');
sqlite.exec('PRAGMA cache_size = -32000');
sqlite.exec('PRAGMA mmap_size = 30000000');

export const db = drizzle(sqlite, { schema });
