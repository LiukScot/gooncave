import fs from 'fs';
import path from 'path';

const writeErrorCodes = new Set(['EACCES', 'EPERM', 'EROFS']);

const describeRuntimeIdentity = () => {
  const parts: string[] = [];
  if (typeof process.getuid === 'function')
    parts.push(`uid ${process.getuid()}`);
  if (typeof process.getgid === 'function')
    parts.push(`gid ${process.getgid()}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
};

export class DirectoryWriteAccessError extends Error {
  code?: string;

  constructor(dirPath: string, operation: string, code?: string) {
    super(
      `${operation} failed because "${dirPath}" is not writable by the GoonCave container user${describeRuntimeIdentity()}. ` +
        'Fix host folder permissions or run api and worker as a user/group that can write there.'
    );
    this.name = 'DirectoryWriteAccessError';
    this.code = code;
  }
}

export const ensureDirectoryWritable = async (
  dirPath: string,
  operation: string
) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
  let probeDir: string | null = null;
  let probePath: string | null = null;

  try {
    probeDir = await fs.promises.mkdtemp(
      path.join(dirPath, '.gooncave-write-test-')
    );
    probePath = path.join(probeDir, 'probe');
    const handle = await fs.promises.open(probePath, 'wx');
    await handle.close();
    await fs.promises.unlink(probePath);
    await fs.promises.rmdir(probeDir);
  } catch (error) {
    if (probePath) {
      await fs.promises.unlink(probePath).catch(() => undefined);
    }
    if (probeDir) {
      await fs.promises.rmdir(probeDir).catch(() => undefined);
    }
    const err = error as NodeJS.ErrnoException;
    if (err.code && writeErrorCodes.has(err.code)) {
      throw new DirectoryWriteAccessError(dirPath, operation, err.code);
    }
    throw error;
  }
};
