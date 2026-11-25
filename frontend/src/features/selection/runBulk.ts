import { toast } from 'sonner';

export type BulkResult<T> = { done: T[]; failed: { item: T; error: unknown }[] };

/**
 * Applies `apply` to each item one after the other, so a site never sees a burst of requests,
 * and collects which ones failed instead of stopping at the first.
 */
export async function applyEach<T>(items: readonly T[], apply: (item: T) => Promise<unknown>): Promise<BulkResult<T>> {
  const result: BulkResult<T> = { done: [], failed: [] };
  for (const item of items) {
    try {
      await apply(item);
      result.done.push(item);
    } catch (error) {
      result.failed.push({ item, error });
    }
  }
  return result;
}

/**
 * Runs a bulk action and reports it in one toast: how many worked and, when some failed, why
 * the first one did, with a button that retries only the failed ones. `verb` completes
 * "<verb> 3 of 4", e.g. "Favorited".
 */
export async function runBulk<T>(
  verb: string,
  items: readonly T[],
  apply: (item: T) => Promise<unknown>
): Promise<BulkResult<T>> {
  const result = await applyEach(items, apply);
  if (result.failed.length === 0) {
    toast.success(`${verb} ${result.done.length} ${result.done.length === 1 ? 'item' : 'items'}`);
    return result;
  }
  const first = result.failed[0].error;
  const reason = first instanceof Error ? first.message : String(first);
  console.error(`[developer] Bulk action "${verb}": ${result.failed.length} of ${items.length} failed. First error: ${reason}`);
  toast.error(`${verb} ${result.done.length} of ${items.length}. ${result.failed.length} failed: ${reason}`, {
    duration: 10_000,
    action: {
      label: 'Retry failed',
      onClick: () => void runBulk(verb, result.failed.map(({ item }) => item), apply)
    }
  });
  return result;
}
