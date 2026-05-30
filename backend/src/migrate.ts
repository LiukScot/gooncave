import { runMigrations } from './db/migrate';

const main = async () => {
  runMigrations();
  process.stdout.write('[migrate] ok\n');
};

void main().catch((err) => {
  process.stderr.write(`[migrate] failed: ${(err as Error).message}\n`);
  process.exit(1);
});
