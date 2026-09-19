import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AuthUser, DuplicatePolicyRun, DuplicateSettings } from '@/api';
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

export type DuplicatesControllerInput = { authUser: AuthUser | null };
export type DuplicatesControllerOutput = { viewProps: DuplicatesViewProps };

export function useDuplicatesController(
  input: DuplicatesControllerInput
): DuplicatesControllerOutput {
  const authenticated = input.authUser !== null;
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
  const [editing, setEditing] = useState(true);
  const [draftStyle, setDraftStyle] = useState<DuplicateSettings['style']>(null);
  const [draftProviders, setDraftProviders] = useState<string[]>([]);
  const [preview, setPreview] = useState<DuplicatePolicyRun | null>(null);

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

  const resetPreview = useCallback(() => {
    setPreview(null);
    previewMutation.reset();
  }, [previewMutation]);

  const selectStyle = useCallback(
    (style: NonNullable<DuplicateSettings['style']>) => {
      setDraftStyle(style);
      resetPreview();
    },
    [resetPreview]
  );

  const toggleProvider = useCallback(
    (provider: string) => {
      setDraftProviders((current) =>
        current.includes(provider)
          ? current.filter((item) => item !== provider)
          : [...current, provider]
      );
      resetPreview();
    },
    [resetPreview]
  );

  const createPreview = useCallback(async () => {
    if (!draftStyle) return;
    const result = await previewMutation.mutateAsync({
      style: draftStyle,
      preferredProviders: draftProviders
    });
    setPreview(result);
  }, [draftProviders, draftStyle, previewMutation]);

  const confirmPreview = useCallback(async () => {
    if (!preview) return;
    await confirmMutation.mutateAsync(preview.id);
    setPreview(null);
    setEditing(false);
  }, [confirmMutation, preview]);

  const turnOff = useCallback(async () => {
    await updateSettings.mutateAsync({ enabled: false });
    setEditing(true);
    setPreview(null);
  }, [updateSettings]);

  const beginChange = useCallback(() => {
    setDraftStyle(settings.style);
    setDraftProviders(settings.preferredProviders);
    setPreview(null);
    setEditing(true);
  }, [settings]);

  const cancelChange = useCallback(() => {
    setDraftStyle(settings.style);
    setDraftProviders(settings.preferredProviders);
    setPreview(null);
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
      preview,
      previewPending: previewMutation.isPending,
      previewError: (previewMutation.error as Error | null)?.message ?? null,
      confirmPending: confirmMutation.isPending,
      confirmError: (confirmMutation.error as Error | null)?.message ?? null,
      latestRun: statusQuery.data?.latestRun ?? null,
      selectStyle,
      toggleProvider,
      createPreview: () => void createPreview(),
      confirmPreview: () => void confirmPreview(),
      cancelPreview: () => setPreview(null),
      beginChange,
      cancelChange,
      turnOff: () => void turnOff(),
      retry: () => retryMutation.mutate(),
      retryPending: retryMutation.isPending
    }
  };
}
