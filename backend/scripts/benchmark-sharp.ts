import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// sharp's callable API is its default export; named imports cover utilities.
// eslint-disable-next-line import-x/no-named-as-default
import sharp, {
  cache as sharpCache,
  concurrency as sharpConcurrency,
  simd as sharpSimd,
  versions as sharpVersions
} from 'sharp';

type CacheSetting = boolean | { memory: number; files: number; items: number };

type Variant = {
  name: string;
  cache: CacheSetting;
  concurrency: number;
  simd: boolean;
};

type Measurement = {
  wallMs: number;
  peakRssBytes: number;
  cpuPercent: number;
  outputBytes: number;
  outputDigest: string;
};

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.tif',
  '.tiff',
  '.webp'
]);

const median = (values: number[]) => {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
};

const listImages = async (root: string): Promise<string[]> => {
  const images: string[] = [];
  const visit = async (directory: string) => {
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true
    });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(resolved);
      if (
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        images.push(resolved);
      }
    }
  };
  await visit(root);
  return images;
};

const measure = async (
  files: string[],
  operation: (file: string) => Promise<Buffer>
): Promise<Measurement> => {
  let peakRssBytes = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  }, 5);
  const digest = crypto.createHash('sha256');
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  let outputBytes = 0;
  try {
    for (const file of files) {
      const output = await operation(file);
      outputBytes += output.byteLength;
      digest.update(output);
    }
  } finally {
    clearInterval(sampler);
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  return {
    wallMs,
    peakRssBytes,
    cpuPercent: ((cpu.user + cpu.system) / 1000 / wallMs) * 100,
    outputBytes,
    outputDigest: digest.digest('hex')
  };
};

const benchmark = async (
  files: string[],
  variants: Variant[],
  workload: 'perceptual-hash' | 'thumbnail'
) => {
  const operation =
    workload === 'perceptual-hash'
      ? (file: string) =>
          sharp(file)
            .rotate()
            .resize(8, 8, { fit: 'fill' })
            .grayscale()
            .raw()
            .toBuffer()
      : (file: string) =>
          sharp(file)
            .rotate()
            .resize(400, 400, { fit: 'inside', position: 'top' })
            .jpeg({ quality: 70 })
            .toBuffer();
  const results = [];
  let baselineDigest = '';
  for (const variant of variants) {
    sharpCache(variant.cache);
    sharpConcurrency(variant.concurrency);
    sharpSimd(variant.simd);
    await measure(files, operation);
    const runs: Measurement[] = [];
    for (let run = 0; run < 3; run += 1) {
      runs.push(await measure(files, operation));
    }
    baselineDigest ||= runs[0].outputDigest;
    results.push({
      variant: variant.name,
      settings: {
        cache: variant.cache,
        concurrency: sharpConcurrency(),
        simd: sharpSimd()
      },
      runs,
      medianWallMs: median(runs.map((run) => run.wallMs)),
      medianThroughputPerSecond:
        files.length /
        (median(runs.map((run) => run.wallMs)) / 1000),
      medianPeakRssBytes: median(runs.map((run) => run.peakRssBytes)),
      medianCpuPercent: median(runs.map((run) => run.cpuPercent)),
      outputCompatible: runs.every(
        (run) => run.outputDigest === baselineDigest
      )
    });
  }
  return results;
};

const root = process.argv[2];
if (!root) {
  throw new Error('Usage: bun scripts/benchmark-sharp.ts <image-dir> [limit]');
}
const limit = Math.max(1, Number.parseInt(process.argv[3] ?? '24', 10));
const files = (await listImages(path.resolve(root))).slice(0, limit);
if (!files.length) throw new Error('No supported images found');
const inputBytes = (
  await Promise.all(
    files.map(async (file) => (await fs.promises.stat(file)).size)
  )
).reduce((sum, size) => sum + size, 0);
const defaultConcurrency = sharpConcurrency();
const variants: Variant[] = [
  { name: 'simd-off', cache: false, concurrency: 1, simd: false },
  {
    name: 'bounded-cache',
    cache: { memory: 50, files: 20, items: 100 },
    concurrency: 1,
    simd: false
  },
  { name: 'simd-on', cache: false, concurrency: 1, simd: true },
  {
    name: 'sharp-defaults',
    cache: true,
    concurrency: defaultConcurrency,
    simd: true
  },
  {
    name: 'bounded-2',
    cache: { memory: 50, files: 20, items: 100 },
    concurrency: 2,
    simd: true
  },
  {
    name: 'bounded-4',
    cache: { memory: 50, files: 20, items: 100 },
    concurrency: 4,
    simd: true
  }
];
const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
const physicalCores = new Set(
  cpuInfo
    .split('\n\n')
    .map((block) => {
      const physical = block.match(/^physical id\s*:\s*(.+)$/m)?.[1];
      const core = block.match(/^core id\s*:\s*(.+)$/m)?.[1];
      return physical && core ? `${physical}:${core}` : null;
    })
    .filter(Boolean)
).size;
const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);

process.stdout.write(
  `${JSON.stringify(
    {
      contract: {
        commit: git.stdout.toString().trim(),
        executionMode: 'native',
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        physicalCores,
        logicalCores: os.cpus().length,
        totalRamBytes: os.totalmem(),
        storage: 'record filesystem type separately',
        environment: {
          MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX ?? null,
          UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? null
        },
        dataset: {
          images: files.length,
          videos: 0,
          inputBytes,
          selection: 'first supported paths in lexical order',
          cacheState: 'one warm-up before three measured runs',
          configuredBooruSites: 'not applicable'
        },
        databaseQueries: 'not applicable',
        sharpVersion: sharpVersions.sharp,
        libvipsVersion: sharpVersions.vips
      },
      workloads: {
        perceptualHash: await benchmark(files, variants, 'perceptual-hash'),
        thumbnail: await benchmark(files, variants, 'thumbnail')
      }
    },
    null,
    2
  )}\n`
);
