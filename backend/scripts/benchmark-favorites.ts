import { mapWithConcurrency } from '../src/lib/taskPool';

type Measurement = {
  wallMs: number;
  itemsPerSecond: number;
  peakActive: number;
  outputOrderPreserved: boolean;
};

const delays = Array.from({ length: 24 }, (_, index) =>
  index % 6 === 0 ? 80 : 20
);

const measure = async (concurrency: number): Promise<Measurement> => {
  let active = 0;
  let peakActive = 0;
  const started = performance.now();
  const output = await mapWithConcurrency(
    delays,
    concurrency,
    async (delayMs, index) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await Bun.sleep(delayMs);
      active -= 1;
      return index;
    }
  );
  const wallMs = performance.now() - started;
  return {
    wallMs,
    itemsPerSecond: delays.length / (wallMs / 1000),
    peakActive,
    outputOrderPreserved: output.every((value, index) => value === index)
  };
};

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const results = [];
for (const concurrency of [1, 4]) {
  await measure(concurrency);
  const runs = [];
  for (let run = 0; run < 3; run += 1) {
    runs.push(await measure(concurrency));
  }
  results.push({
    concurrency,
    runs,
    medianWallMs: median(runs.map((run) => run.wallMs)),
    medianItemsPerSecond: median(runs.map((run) => run.itemsPerSecond))
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      contract: {
        workload: '24 synthetic network-bound items',
        delaysMs: delays,
        warmups: 1,
        measuredRuns: 3,
        scope: 'scheduler only; end-to-end semantics are covered by favorites.test.ts'
      },
      results
    },
    null,
    2
  )}\n`
);
