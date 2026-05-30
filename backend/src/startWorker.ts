import { runMigrations } from './db/migrate';
import { startAutoScanner } from './worker';

export const bootWorker = async () => {
  runMigrations();
  await startAutoScanner();
};

if (require.main === module) {
  console.log('[worker] auto-scan manager started');
  void bootWorker()
    .then(() => {
      if (process.env.WORKER_EXIT_AFTER_BOOT === 'true') {
        process.exit(0);
      }
    })
    .catch((error) => {
      console.error('[worker] startup failed', error);
      process.exit(1);
    });
}
