export type TaskPool = {
  run: (task: () => Promise<void>) => Promise<void>;
  drain: () => Promise<void>;
};

export const createTaskPool = (limit: number): TaskPool => {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Task pool limit must be a positive integer');
  }
  const active = new Set<Promise<void>>();
  let firstError: unknown;

  const throwFirstError = () => {
    if (firstError !== undefined) throw firstError;
  };

  return {
    run: async (task) => {
      if (active.size >= limit) {
        await Promise.race(active);
        throwFirstError();
      }
      const pending = Promise.resolve()
        .then(task)
        .catch((error: unknown) => {
          firstError ??= error;
        })
        .finally(() => active.delete(pending));
      active.add(pending);
    },
    drain: async () => {
      await Promise.all(active);
      throwFirstError();
    }
  };
};

export const mapWithConcurrency = async <TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  operation: (item: TItem, index: number) => Promise<TResult>
): Promise<TResult[]> => {
  const results = new Array<TResult>(items.length);
  const pool = createTaskPool(limit);
  for (const [index, item] of items.entries()) {
    await pool.run(async () => {
      results[index] = await operation(item, index);
    });
  }
  await pool.drain();
  return results;
};
