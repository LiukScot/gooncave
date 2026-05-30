/**
 * One-shot seed script used by the Playwright `webServer.command`.
 *
 * Calls `registerLocalUser` directly (no HTTP) to add the E2E account
 * to the freshly-deleted SQLite database, then exits. The Playwright
 * config wipes `DB_PATH` first, so this always runs against an empty
 * DB and is idempotent.
 *
 * Why not POST /auth/register? That would need two Fastify boots
 * (seed-time + serve-time), which doubles the cold start. Calling
 * the service directly is the same code path with one less round trip.
 */
import { runMigrations } from './db/migrate';
import { authRepo } from './db/repos/authRepo';
import { hashPassword } from './services/auth';

const username = process.env.E2E_USERNAME ?? 'smoke';
const password = process.env.E2E_PASSWORD ?? 'Password123';

const main = async () => {
  runMigrations();
  const existing = await authRepo.findUserByUsername(username);
  if (existing) {
    process.stdout.write(`[smoke-seed] user "${username}" already exists, skipping\n`);
    return;
  }
  const passwordHash = await hashPassword(password);
  // Library root will be auto-managed by the server's syncUserLibraryRoot
  // path on first login; a placeholder is fine here.
  await authRepo.createUser({ username, passwordHash, libraryRoot: '' });
  process.stdout.write(`[smoke-seed] created user "${username}"\n`);
};

void main()
  .catch((err) => {
    process.stderr.write(`[smoke-seed] failed: ${(err as Error).message}\n`);
    process.exit(1);
  })
  .finally(() => {
    // SQLite handles close on process exit; explicit close avoids a
    // dangling handle warning under Playwright's child-process supervisor.
    setImmediate(() => process.exit(0));
  });
