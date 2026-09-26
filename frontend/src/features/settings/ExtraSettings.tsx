import type { ExtraSettings as ExtraSettingsValue } from '@/api';
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
    key: 'galleryUnreadOnlyEnabled',
    label: 'Read tracking',
    description:
      'Track what you read and offer "Unread only" in Explore and random Gallery order.'
  }
];

export function ExtraSettings() {
  const settings = useExtraSettings();
  const updateSettings = useUpdateExtraSettings();
  const error = (updateSettings.error as Error | null)?.message ?? null;

  return (
    <div className="col-12">
      <div className="list-group">
        {TOGGLES.map(({ key, label, description }) => (
          <div key={key} className="list-group-item flex items-center gap-3">
            <span className="flex-1 min-w-0">
              <label className="block font-medium" htmlFor={`extra-${key}`}>
                {label}
              </label>
              <span className="block text-muted-foreground text-xs">
                {description}
              </span>
            </span>
            <input
              className="form-check-input shrink-0"
              type="checkbox"
              id={`extra-${key}`}
              name={`extra-${key}`}
              checked={settings[key]}
              onChange={() => updateSettings.mutate({ [key]: !settings[key] })}
            />
          </div>
        ))}
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
      </div>
      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
