import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DeviceProfile, DuplicateSettings } from '@/api';
import type { DuplicatesViewProps } from '@/features/duplicates/DuplicatesView';
import { useBooruSites } from '@/hooks/booru-sites';
import {
  useConfirmDuplicatePolicy,
  useDuplicatePolicyStatus,
  useDuplicateSettings,
  usePreviewDuplicatePolicy,
  useRetryDuplicatePolicy,
  useUpdateDuplicateSettings
} from '@/hooks/duplicates';

export type DuplicatesControllerInput = { authUser: DeviceProfile | null };
export type DuplicatesControllerOutput = { viewProps: DuplicatesViewProps };

export function useDuplicatesController(
  input: DuplicatesControllerInput
): DuplicatesControllerOutput {
  const authenticated = input.authUser !== null && (input.authUser.capabilities?.duplicates ?? input.authUser.capabilities?.processing) !== false;
  const settingsQuery = useDuplicateSettings({ enabled: authenticated });
  const sitesQuery = useBooruSites({ enabled: authenticated });
  const updateSettings = useUpdateDuplicateSettings();
  const previewMutation = usePreviewDuplicatePolicy();
  const confirmMutation = useConfirmDuplicatePolicy();
  const retryMutation = useRetryDuplicatePolicy();
  const settings = useMemo<DuplicateSettings>(
    () => settingsQuery.data ?? {
      enabled: false,
      style: null,
      preferredProviders: []
    },
    [settingsQuery.data]
  );
  const statusQuery = useDuplicatePolicyStatus({
    enabled: authenticated,
    watch: settings.enabled
  });
  const [notReady, setNotReady] = useState<string | null>(null);
  const [editing, setEditing] = useState(true);
  const [draftStyle, setDraftStyle] = useState<DuplicateSettings['style']>(null);
  const [draftProviders, setDraftProviders] = useState<string[]>([]);

  useEffect(() => {
    if (!settingsQuery.data) return;
    setDraftStyle(settingsQuery.data.style);
    setDraftProviders(settingsQuery.data.preferredProviders);
    setEditing(!settingsQuery.data.enabled);
  }, [settingsQuery.data]);

  const providers = useMemo(
    () =>
      (sitesQuery.data ?? []).map((site) => ({
        key: site.presetKey ?? site.id,
        label: site.name,
        iconUrl: (() => {
          try {
            return `${new URL(site.baseUrl).origin}/favicon.ico`;
          } catch {
            return null;
          }
        })()
      })),
    [sitesQuery.data]
  );

  const selectStyle = useCallback(
    (style: NonNullable<DuplicateSettings['style']>) => {
      setDraftStyle(style);
    },
    []
  );

  const toggleProvider = useCallback(
    (provider: string) => {
      setDraftProviders((current) =>
        current.includes(provider)
          ? current.filter((item) => item !== provider)
          : [...current, provider]
      );
    },
    []
  );

  // The core still plans the actions first and applies exactly that plan.
  const turnOn = useCallback(async () => {
    if (!draftStyle) return;
    const planned = await previewMutation.mutateAsync({
      style: draftStyle,
      preferredProviders: draftProviders
    });
    setNotReady(planned.status === 'ready' ? null : (planned.error ?? 'The check did not finish.'));
    if (planned.status !== 'ready') return;
    await confirmMutation.mutateAsync(planned.id);
    setEditing(false);
  }, [confirmMutation, draftProviders, draftStyle, previewMutation]);

  const turnOff = useCallback(async () => {
    await updateSettings.mutateAsync({ enabled: false });
    setEditing(true);
  }, [updateSettings]);

  const beginChange = useCallback(() => {
    setDraftStyle(settings.style);
    setDraftProviders(settings.preferredProviders);
    setEditing(true);
  }, [settings]);

  const cancelChange = useCallback(() => {
    setDraftStyle(settings.style);
    setDraftProviders(settings.preferredProviders);
    setEditing(!settings.enabled);
  }, [settings]);

  return {
    viewProps: {
      settings,
      settingsLoading: settingsQuery.isLoading,
      settingsError:
        (settingsQuery.error as Error | null)?.message ??
        (updateSettings.error as Error | null)?.message ??
        null,
      providers,
      editing,
      draftStyle,
      draftProviders,
      turnOnPending: previewMutation.isPending || confirmMutation.isPending,
      turnOnError:
        notReady ??
        (previewMutation.error as Error | null)?.message ??
        (confirmMutation.error as Error | null)?.message ??
        null,
      latestRun: statusQuery.data?.latestRun ?? null,
      queued: statusQuery.data?.queued ?? false,
      selectStyle,
      toggleProvider,
      turnOn: () => void turnOn().catch(() => undefined), // the mutations expose their own error
      beginChange,
      cancelChange,
      turnOff: () => void turnOff(),
      retry: () => retryMutation.mutate(),
      retryPending: retryMutation.isPending
    }
  };
}
