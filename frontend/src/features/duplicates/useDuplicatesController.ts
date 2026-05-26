import { useCallback, useMemo, useState } from 'react';

import {
  useDuplicateSettings,
  useDuplicateScanStatus,
  useStartDuplicateScan,
  useUpdateDuplicateSettings,
} from '@/hooks/duplicates';
import { useDeleteFile } from '@/hooks/files';
import { basenameFromPath } from '@/lib/format';
import type {
  AuthUser,
  DuplicateFile,
  DuplicateGroup,
  DuplicateScanOptions,
  DuplicateScanStats,
  DuplicateScanStatus,
  DuplicateSettings,
} from '@/api';
import { api } from '@/api';
import type { DuplicatePair, DuplicatesViewProps } from './DuplicatesView';

// ── helpers (pure, module-scope) ──────────────────────────────────────────────

const favoriteProviderPriority = ['E621', 'DANBOORU'] as const;

const resolveArea = (file: DuplicateFile): number =>
  (file.width ?? 0) * (file.height ?? 0);

const resolveFavoriteRank = (file: DuplicateFile): number => {
  const providers = file.favoriteProviders ?? [];
  let rank = 0;
  favoriteProviderPriority.forEach((provider, index) => {
    if (providers.includes(provider)) {
      rank = Math.max(rank, favoriteProviderPriority.length - index);
    }
  });
  return rank;
};

const resolveFavoriteLabel = (file: DuplicateFile): string | null => {
  const providers = file.favoriteProviders ?? [];
  if (!providers.length) return null;
  return providers.map((p) => p.toLowerCase()).join(', ');
};

const resolveFavoriteOverlap = (a: DuplicateFile, b: DuplicateFile): boolean => {
  const pa = a.favoriteProviders ?? [];
  const pb = b.favoriteProviders ?? [];
  if (!pa.length || !pb.length) return true;
  return pa.some((p) => pb.includes(p));
};

const compareDuplicateQuality = (a: DuplicateFile, b: DuplicateFile): number => {
  const areaA = resolveArea(a);
  const areaB = resolveArea(b);
  if (areaA !== areaB) return areaB - areaA;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.path.localeCompare(b.path);
};

const compareDuplicatePreference = (a: DuplicateFile, b: DuplicateFile): number => {
  const rankA = resolveFavoriteRank(a);
  const rankB = resolveFavoriteRank(b);
  if (rankA !== rankB) return rankB - rankA;
  return compareDuplicateQuality(a, b);
};

const pickDuplicateSuggestion = (
  a: DuplicateFile,
  b: DuplicateFile
): { keepId: string | null; reason: string } => {
  const conflict =
    (a.favoriteProviders?.length ?? 0) > 0 &&
    (b.favoriteProviders?.length ?? 0) > 0 &&
    !resolveFavoriteOverlap(a, b);
  if (conflict) {
    return { keepId: null, reason: 'favorites from different sources (keep both)' };
  }
  const rankA = resolveFavoriteRank(a);
  const rankB = resolveFavoriteRank(b);
  if (rankA !== rankB) {
    const winner = rankA > rankB ? a : b;
    const winnerLabel = resolveFavoriteLabel(winner);
    if (rankA > 0 && rankB > 0) {
      return {
        keepId: winner.id,
        reason: `preferred favorite source (${winnerLabel ?? 'favorite'})`,
      };
    }
    return {
      keepId: winner.id,
      reason: `synced favorite (${winnerLabel ?? 'favorite'})`,
    };
  }
  const areaA = resolveArea(a);
  const areaB = resolveArea(b);
  if (areaA !== areaB) {
    return { keepId: areaA > areaB ? a.id : b.id, reason: 'larger resolution' };
  }
  if (a.sizeBytes !== b.sizeBytes) {
    return { keepId: a.sizeBytes > b.sizeBytes ? a.id : b.id, reason: 'larger file size' };
  }
  const label = resolveFavoriteLabel(a);
  if (label) {
    return { keepId: a.id, reason: `same resolution & size (${label})` };
  }
  return { keepId: a.id, reason: 'same resolution & size' };
};

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// ── types ─────────────────────────────────────────────────────────────────────

type FetchState = { loading: boolean; error: string | null };

export type DuplicatesControllerInput = {
  /** Gates queries — pass null when unauthenticated. */
  authUser: AuthUser | null;
};

export type DuplicatesControllerOutput = {
  /** Exact shape DuplicatesView expects. Spread or pass directly. */
  viewProps: DuplicatesViewProps;
  /** Exposed for cross-feature coordination in the parent shell. */
  duplicateScanStatus: DuplicateScanStatus | null;
};

// ── hook ──────────────────────────────────────────────────────────────────────

export function useDuplicatesController(
  input: DuplicatesControllerInput
): DuplicatesControllerOutput {
  const authenticated = input.authUser !== null;

  // TanStack: settings query
  const settingsQuery = useDuplicateSettings({ enabled: authenticated });

  // TanStack: scan status — refetch only while a scan is running
  const scanStatusQuery = useDuplicateScanStatus({
    enabled: authenticated,
    refetchInterval: false, // controller drives polling via loadDuplicates loop
  });

  // TanStack: mutations
  const startScanMutation = useStartDuplicateScan();
  const updateSettingsMutation = useUpdateDuplicateSettings();
  const deleteFileMutation = useDeleteFile();

  // ── local state ──────────────────────────────────────────────────────────

  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [duplicateStats, setDuplicateStats] = useState<DuplicateScanStats | null>(null);
  const [duplicateState, setDuplicateState] = useState<FetchState>({
    loading: false,
    error: null,
  });
  const [duplicateScanStatus, setDuplicateScanStatus] = useState<DuplicateScanStatus | null>(null);
  const [duplicateAction, setDuplicateAction] = useState<{
    loadingId: string | null;
    error: string | null;
  }>({ loadingId: null, error: null });
  const [duplicateResolvedKeys, setDuplicateResolvedKeys] = useState<string[]>([]);
  const [duplicateSettingsState, setDuplicateSettingsState] = useState<FetchState>({
    loading: false,
    error: null,
  });
  const [duplicateOptions, setDuplicateOptions] = useState<DuplicateScanOptions>({
    mediaType: 'ALL',
    pixelThreshold: 0.005,
    sampleSize: 96,
    videoFrames: 3,
    maxComparisons: 2000,
  });

  // Reflect TanStack settings query into FetchState + settings value
  const duplicateSettings: DuplicateSettings = settingsQuery.data ?? { autoResolve: false };
  const settingsLoadingState: FetchState = {
    loading: settingsQuery.isLoading,
    error: (settingsQuery.error as Error | null)?.message ?? null,
  };
  // Merge TanStack-driven state with manual settingsState (covers mutation path)
  const mergedSettingsState: FetchState = duplicateSettingsState.loading
    ? duplicateSettingsState
    : settingsLoadingState;

  // ── derived: pairs ────────────────────────────────────────────────────────

  const duplicatePairs = useMemo<DuplicatePair[]>(() => {
    const pairs: DuplicatePair[] = [];
    const resolved = new Set(duplicateResolvedKeys);
    duplicateGroups.forEach((group) => {
      if (group.files.length < 2) return;
      const sorted = [...group.files].sort(compareDuplicatePreference);
      const primary = sorted[0];
      sorted.slice(1).forEach((other) => {
        const suggestion = pickDuplicateSuggestion(primary, other);
        const key = `${group.key}:${primary.id}:${other.id}`;
        if (resolved.has(key)) return;
        pairs.push({
          key,
          groupKey: group.key,
          left: primary,
          right: other,
          suggestedKeepId: suggestion.keepId,
          reason: suggestion.reason,
        });
      });
    });
    return pairs;
  }, [duplicateGroups, duplicateResolvedKeys]);

  // ── handlers ─────────────────────────────────────────────────────────────

  const updateDuplicateSettings = useCallback(
    async (updates: Partial<DuplicateSettings>) => {
      setDuplicateSettingsState({ loading: true, error: null });
      try {
        await updateSettingsMutation.mutateAsync(updates);
        setDuplicateSettingsState({ loading: false, error: null });
      } catch (err) {
        setDuplicateSettingsState({ loading: false, error: (err as Error).message });
      }
    },
    [updateSettingsMutation]
  );

  /**
   * Starts a duplicate scan and polls until completion.
   * Polling strategy: imperative loop with 800 ms wait — mirrors original
   * App.tsx behaviour. Using refetchInterval on useDuplicateScanStatus would
   * require coordinating start/stop signals; the loop is simpler and correct.
   */
  const loadDuplicates = useCallback(async () => {
    setDuplicateState({ loading: true, error: null });
    try {
      const start = await startScanMutation.mutateAsync(duplicateOptions);
      let status = start.state;
      setDuplicateScanStatus(status);
      let lastUpdatedAt = status.updatedAt;
      let staleSince = Date.now();
      const STALE_TIMEOUT_MS = 5 * 60 * 1000;

      while (true) {
        if (status.progress) {
          setDuplicateScanStatus(status);
        }
        if (status.status === 'done' && status.result) {
          setDuplicateGroups(status.result.groups);
          setDuplicateStats(status.result.stats);
          setDuplicateState({ loading: false, error: null });
          if (duplicateSettings.autoResolve) {
            void autoResolveDuplicates(status.result.groups);
          }
          return;
        }
        if (status.status === 'error') {
          throw new Error(status.error ?? 'Duplicate scan failed');
        }
        if (status.status !== 'running') {
          break;
        }
        if (status.updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = status.updatedAt;
          staleSince = Date.now();
        } else if (Date.now() - staleSince > STALE_TIMEOUT_MS) {
          throw new Error('Duplicate scan timed out (no progress for 5 minutes)');
        }
        await wait(800);
        status = await api.getDuplicateScanStatus();
        setDuplicateScanStatus(status);
      }
    } catch (err) {
      setDuplicateState({ loading: false, error: (err as Error).message });
    }
    // autoResolveDuplicates is defined below; stable via useCallback so safe in dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateOptions, duplicateSettings.autoResolve, startScanMutation]);

  const resolveDuplicateChoice = useCallback(
    async (
      _keep: DuplicateFile,
      discard: DuplicateFile,
      options: { confirm?: boolean } = {}
    ) => {
      if (options.confirm !== false) {
        if (!window.confirm(`Delete "${basenameFromPath(discard.path)}"? This cannot be undone.`)) {
          return;
        }
      }
      setDuplicateAction({ loadingId: discard.id, error: null });
      try {
        await deleteFileMutation.mutateAsync(discard.id);
        setDuplicateGroups((prev) =>
          prev
            .map((group) => ({
              ...group,
              files: group.files.filter((file) => file.id !== discard.id),
            }))
            .filter((group) => group.files.length > 1)
        );
        setDuplicateAction({ loadingId: null, error: null });
      } catch (err) {
        setDuplicateAction({ loadingId: null, error: (err as Error).message });
      }
    },
    [deleteFileMutation]
  );

  const resolveDuplicateKeepBoth = useCallback((pairKey: string) => {
    setDuplicateResolvedKeys((prev) => (prev.includes(pairKey) ? prev : [...prev, pairKey]));
  }, []);

  const autoResolveDuplicates = useCallback(
    async (groups: DuplicateGroup[]) => {
      const candidates = groups.filter((group) => group.files.length > 1);
      if (!candidates.length) return;
      const discardPairs: { keep: DuplicateFile; discard: DuplicateFile; key: string }[] = [];
      const keepBothKeys: string[] = [];
      for (const group of candidates) {
        const sorted = [...group.files].sort(compareDuplicatePreference);
        const winner = sorted[0];
        sorted.slice(1).forEach((file) => {
          if (file.id === winner.id) return;
          const suggestion = pickDuplicateSuggestion(winner, file);
          const key = `${group.key}:${winner.id}:${file.id}`;
          if (!suggestion.keepId) {
            keepBothKeys.push(key);
            return;
          }
          const keep = suggestion.keepId === winner.id ? winner : file;
          const discard = suggestion.keepId === winner.id ? file : winner;
          discardPairs.push({ keep, discard, key });
        });
      }
      if (!discardPairs.length && keepBothKeys.length === 0) return;
      if (keepBothKeys.length > 0) {
        setDuplicateResolvedKeys((prev) => Array.from(new Set([...prev, ...keepBothKeys])));
      }
      if (!discardPairs.length) return;
      const confirmed = window.confirm(
        `Auto-resolve is enabled. Delete ${discardPairs.length} duplicates now? This cannot be undone.`
      );
      if (!confirmed) return;
      for (const pair of discardPairs) {
        try {
          await resolveDuplicateChoice(pair.keep, pair.discard, { confirm: false });
          setDuplicateResolvedKeys((prev) =>
            prev.includes(pair.key) ? prev : [...prev, pair.key]
          );
        } catch (err) {
          setDuplicateAction({ loadingId: null, error: (err as Error).message });
          break;
        }
      }
    },
    [resolveDuplicateChoice]
  );

  // ── assemble viewProps ────────────────────────────────────────────────────

  const viewProps: DuplicatesViewProps = {
    duplicateSettings,
    duplicateSettingsState: mergedSettingsState,
    updateDuplicateSettings,

    duplicateOptions,
    setDuplicateOptions,

    duplicateState,
    duplicateScanStatus,
    loadDuplicates: () => void loadDuplicates(),

    duplicatePairs,
    duplicateStats,

    duplicateAction,
    resolveDuplicateChoice: (keep, discard) => void resolveDuplicateChoice(keep, discard),
    resolveDuplicateKeepBoth,
  };

  return {
    viewProps,
    duplicateScanStatus: duplicateScanStatus ?? scanStatusQuery.data ?? null,
  };
}
