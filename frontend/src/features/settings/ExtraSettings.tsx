import { useState } from 'react';

import { AutomaticTagging } from './AutomaticTagging';
import { ProviderDiagnostics } from './ProviderDiagnostics';
import { TrashToggle } from './TrashSettings';


import { api, type ExtraSettings as ExtraSettingsValue } from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import { PillSwitch } from '@/components/pill-switch';
import { flushReadQueue } from '@/features/read-marks/readQueue';
import { FeatureUnavailable } from '@/features/shell/FeatureUnavailable';
import { useExtraSettings, useUpdateExtraSettings } from '@/hooks/settings';

const TOGGLES: {
  key: Exclude<keyof ExtraSettingsValue, 'maxGridColumns'>;
  label: string;
  description: string;
}[] = [
  {
    key: 'voteSystemEnabled',
    label: 'Gallery vote system',
    description:
      'Rate a file up or down once every 24 hours, and sort the gallery by score.'
  },
  {
    key: 'autoVoteOnFavorite',
    label: 'Upvote on favorite in explore',
    description:
      'Also vote a post up when you favorite it on Explore, on boorus that have voting.'
  },
  {
    key: 'exploreStackDuplicates',
    label: 'Stack duplicate posts in Explore',
    description: 'Group copies of the same image from different providers on each loaded page.'
  },
  {
    key: 'deleteAddedPhotos',
    label: 'Delete from Photos after adding',
    description:
      'Add files with "Add files" from the photo library, and iOS deletes the originals once they are in GoonCave. iOS asks you to confirm, and keeps them in Recently Deleted for 30 days.'
  },
  {
    key: 'readTrackingEnabled',
    label: 'History',
    description:
      'Remember the posts you scroll past or open in Explore: list them under History and offer "Unread only". Turning it off deletes them.'
  }
];

export function ExtraSettings({
  providerReportsAvailable = true,
  photoLibraryAvailable = false
}: {
  providerReportsAvailable?: boolean;
  photoLibraryAvailable?: boolean;
}) {
  const settings = useExtraSettings();
  const updateSettings = useUpdateExtraSettings();
  const confirm = useConfirm();
  const [clearError, setClearError] = useState<string | null>(null);
  const error =
    clearError ?? (updateSettings.error as Error | null)?.message ?? null;

  const toggle = async (key: (typeof TOGGLES)[number]['key']) => {
    if (key === 'readTrackingEnabled' && settings.readTrackingEnabled) {
      const confirmed = await confirm(
        'Every post History saved is deleted, here and on the devices this one syncs with.',
        { title: 'Turn off History?', confirmLabel: 'Turn off and delete', destructive: true }
      );
      if (!confirmed) return;
      setClearError(null);
      try {
        // Marks still queued would land after the delete and start a new history.
        await flushReadQueue('post');
        await api.clearRead('post');
      } catch (err) {
        setClearError(`Could not delete the history: ${(err as Error).message}`);
        return;
      }
    }
    updateSettings.mutate({ [key]: !settings[key] });
  };

  return (
    <div className="col-12">
      <div className="list-group">
        <AutomaticTagging />
        {TOGGLES.filter(({ key }) => key !== 'deleteAddedPhotos' || photoLibraryAvailable).map(({ key, label, description }) => (
          <div key={key} className="list-group-item flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <label className="block font-medium" htmlFor={`extra-${key}`}>
                {label}
              </label>
              <span className="block text-muted-foreground text-xs">
                {description}
              </span>
            </span>
            <PillSwitch
              
              id={`extra-${key}`}
              name={`extra-${key}`}
              checked={settings[key]}
              onChange={() => void toggle(key)}
            />
          </div>
        ))}
        <TrashToggle />
        <div className="list-group-item flex items-center gap-3">
          <span className="flex-1 min-w-0">
            <label className="block font-medium" htmlFor="extra-maxGridColumns">
              Maximum grid columns
            </label>
            <span className="block text-muted-foreground text-xs">
              Limit the number of columns in Explore and Gallery on wide screens.
            </span>
          </span>
          <select
            id="extra-maxGridColumns"
            name="maxGridColumns"
            className="form-select form-select-sm w-auto extra-columns-select"
            value={settings.maxGridColumns}
            onChange={(event) => updateSettings.mutate({ maxGridColumns: Number(event.target.value) })}
          >
            <option value={0}>Automatic</option>
            {Array.from({ length: 11 }, (_, index) => index + 2).map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </select>
        </div>
        <div className="list-group-item flex items-center gap-3">
          <span className="flex-1 min-w-0">
            <label className="block font-medium" htmlFor="extra-developerMode">
              Developer mode
            </label>
            <span className="block text-muted-foreground text-xs">
              Show diagnostics across the app and write request details to the app log.
            </span>
          </span>
          <PillSwitch
            
            id="extra-developerMode"
            name="developerMode"
            checked={settings.developerMode}
            onChange={() => updateSettings.mutate({ developerMode: !settings.developerMode })}
          />
        </div>
      </div>
      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
      {settings.developerMode ? providerReportsAvailable ? <ProviderDiagnostics /> : <FeatureUnavailable feature="Provider reports" /> : null}
    </div>
  );
}
