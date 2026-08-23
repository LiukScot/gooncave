import type { ExtraSettings as ExtraSettingsValue } from '@/api';
import { useExtraSettings, useUpdateExtraSettings } from '@/hooks/settings';

const TOGGLES: {
  key: keyof ExtraSettingsValue;
  label: string;
  description: string;
}[] = [
  {
    key: 'gamesTabEnabled',
    label: 'Games tab',
    description: 'Show the Games tab in the navigation bar.'
  },
  {
    key: 'voteSystemEnabled',
    label: 'Vote system',
    description:
      'Rate a file up or down once every 24 hours, and sort the gallery by score.'
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
      </div>
      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
