import fs from 'node:fs';
import path from 'node:path';

const backendRoot = path.resolve(import.meta.dirname, '..');
const sourceDir = path.join(backendRoot, 'src', 'db', 'migrations');
const targetDir = path.join(backendRoot, 'dist', 'db', 'migrations');

fs.mkdirSync(targetDir, { recursive: true });

for (const entry of fs.readdirSync(sourceDir)) {
  if (!entry.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(sourceDir, entry), path.join(targetDir, entry));
}
