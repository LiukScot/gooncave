import { useQuery } from '@tanstack/react-query';
import {
  Columns3,
  Ellipsis,
  FastForward,
  HardDrive,
  History,
  ImageMinus,
  Layers,
  MoveVertical,
  Pointer,
  Star,
  ThumbsUp
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { AutomaticTagging } from './AutomaticTagging';
import { TrashToggle } from './TrashSettings';



import {
  api,
  CACHE_LIMITS_GB,
  type DoubleTapAction,
  type ExtraSettings as ExtraSettingsValue
} from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import { lockAvailable } from '@/features/app-lock/appLock';
import { AppLockSetting } from '@/features/app-lock/AppLockSetting';
import { flushReadQueue } from '@/features/read-marks/readQueue';
import { useExtraSettings, useUpdateExtraSettings } from '@/hooks/settings';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

type Group = 'gestures' | 'browsing' | 'privacy' | 'data';

const GROUP_TITLES: Record<Group, string> = {
  gestures: 'Gestures',
  browsing: 'Browsing',
  privacy: 'Privacy',
  data: 'Data'
};

/** The icon every Extra row starts with. */
function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />;
}

function ExtraGroup({ group, children }: { group: Group; children: ReactNode }) {
  return (
    <section className="extra-group" aria-labelledby={`extra-group-${group}`}>
      <h2 id={`extra-group-${group}`} className="appearance-group-title extra-group-title">
        {GROUP_TITLES[group]}
      </h2>
      <div className="list-group">{children}</div>
    </section>
  );
}

const DOUBLE_TAP_CHOICES: [DoubleTapAction, string][] = [
  ['zoom', 'Zoom in'],
  ['exit', 'Leave fullscreen']
];

const TOGGLES: {
  key: Exclude<
    keyof ExtraSettingsValue,
    'maxGridColumns' | 'videoSkipSeconds' | 'doubleTap' | 'cacheLimitGb'
  >;
  label: string;
  description: string;
  icon: LucideIcon;
  group: Group;
}[] = [
  {
    key: 'starsEnabled',
    icon: Star,
    group: 'browsing',
    label: 'Gallery stars',
    description:
      'Give a file a star once every 24 hours, and sort the gallery by stars.'
  },
  {
    key: 'autoVoteOnFavorite',
    icon: ThumbsUp,
    group: 'browsing',
    label: 'Upvote on favorite in explore',
    description:
      'Also vote a post up when you favorite it on Explore, on boorus that have voting.'
  },
  {
    key: 'exploreStackDuplicates',
    icon: Layers,
    group: 'browsing',
    label: 'Stack duplicate posts in Explore',
    description: 'Group copies of the same image from different providers.'
  },
  {
    key: 'deleteAddedPhotos',
    icon: ImageMinus,
    group: 'data',
    label: 'Delete from Photos after adding',
    description:
      'Add files with "Add files" from the photo library, and iOS deletes the originals once they are in GoonCave. iOS asks you to confirm, and keeps them in Recently Deleted for 30 days.'
  },
  {
    key: 'pullFullscreen',
    icon: MoveVertical,
    group: 'gestures',
    label: 'Drag for fullscreen',
    description:
      'At the top of a file, drag the picture down to view it fullscreen. In fullscreen, drag up or down to leave.'
  },
  {
    key: 'fullscreenActions',
    icon: Ellipsis,
    group: 'gestures',
    label: 'Actions in fullscreen',
    description:
      'Show the More actions button in fullscreen, beside the button that leaves it, to give a star, vote, share, favorite or delete without leaving.'
  },
  {
    key: 'readTrackingEnabled',
    icon: History,
    group: 'browsing',
    label: 'History',
    description: 'Lists what you have seen, for History and Unread only. Off deletes it.'
  }
];

const cacheLimitLabel = (gb: number): string => (gb === 0 ? 'Unlimited' : `${gb} GB`);

function CacheLimit() {
  const settings = useExtraSettings();
  const updateSettings = useUpdateExtraSettings();
  const usage = useQuery({
    queryKey: queryKeys.settings.cacheUsage(),
    queryFn: () => api.getCacheUsage()
  });
  // Saved when the thumb is let go: every position passed on the way would trim the cache.
  const [draft, setDraft] = useState<number | null>(null);
  const position = draft ?? Math.max(0, CACHE_LIMITS_GB.indexOf(settings.cacheLimitGb));
  const shown = CACHE_LIMITS_GB[position];
  const last = CACHE_LIMITS_GB.length - 1;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const gb = CACHE_LIMITS_GB[draft];
    if (gb === settings.cacheLimitGb) return;
    updateSettings.mutate(
      { cacheLimitGb: gb },
      // A smaller limit frees space at once.
      { onSuccess: () => void usage.refetch() }
    );
  };
  const used = usage.data
    ? `${formatBytes(usage.data.bytes)} used.`
    : usage.isError
      ? 'The space used could not be read.'
      : '';
  return (
    <div className="list-group-item flex flex-col gap-2">
      <span className="flex items-center gap-3">
        <RowIcon icon={HardDrive} />
        <label className="flex-1 min-w-0 font-medium" htmlFor="extra-cacheLimitGb">
          Cache size
        </label>
        <output htmlFor="extra-cacheLimitGb" className="text-sm tabular-nums">
          {cacheLimitLabel(shown)}
        </output>
      </span>
      <span className="block text-muted-foreground text-xs">
        Thumbnails, post details and search pages already loaded open faster, and still
        show when a site does not answer. Past the limit, what you opened longest ago goes
        first. {used}
      </span>
      <input
        id="extra-cacheLimitGb"
        name="cacheLimitGb"
        className="settings-range"
        type="range"
        min={0}
        max={last}
        step={1}
        value={position}
        aria-valuetext={cacheLimitLabel(shown)}
        style={{ '--progress': `${(position / last) * 100}%` } as React.CSSProperties}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </div>
  );
}

export function ExtraSettings({
  photoLibraryAvailable = false
}: {
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
        'Every post and opened file History saved is deleted, here and on the devices this one syncs with.',
        { title: 'Turn off History?', confirmLabel: 'Turn off and delete', destructive: true }
      );
      if (!confirmed) return;
      setClearError(null);
      try {
        // Marks still queued would land after the delete and start a new history.
        await flushReadQueue('post');
        await Promise.all([api.clearRead('post'), api.clearRead('opened')]);
      } catch (err) {
        setClearError(`Could not delete the history: ${(err as Error).message}`);
        return;
      }
    }
    updateSettings.mutate({ [key]: !settings[key] });
  };

  const toggles = (group: Group) =>
    TOGGLES.filter(
      (item) => item.group === group && (item.key !== 'deleteAddedPhotos' || photoLibraryAvailable)
    ).map(({ key, label, description, icon }) => (
      <div key={key} className="list-group-item flex items-center gap-3">
        <RowIcon icon={icon} />
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
          onChange={() => void toggle(key)}
        />
      </div>
    ));

  return (
    <div className="col-12">
      <ExtraGroup group="gestures">
        {toggles('gestures')}
        <div className="list-group-item flex items-center gap-3">
          <RowIcon icon={Pointer} />
          <span className="flex-1 min-w-0">
            <label className="block font-medium" htmlFor="extra-doubleTap">
              Double tap in fullscreen
            </label>
            <span className="block text-muted-foreground text-xs">
              Outside fullscreen a double tap opens it. Inside, it zooms in where you tap and a second one zooms back out, or it leaves fullscreen.
            </span>
          </span>
          <select
            id="extra-doubleTap"
            name="doubleTap"
            className="form-select form-select-sm w-auto extra-select"
            value={settings.doubleTap}
            onChange={(event) => {
              const choice = DOUBLE_TAP_CHOICES.find(([value]) => value === event.target.value);
              if (choice) updateSettings.mutate({ doubleTap: choice[0] });
            }}
          >
            {DOUBLE_TAP_CHOICES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="list-group-item flex items-center gap-3">
          <RowIcon icon={FastForward} />
          <span className="flex-1 min-w-0">
            <label className="block font-medium" htmlFor="extra-videoSkipSeconds">
              Video skip
            </label>
            <span className="block text-muted-foreground text-xs">
              How far a double tap on the left or right of a video goes back or forward.
            </span>
          </span>
          <select
            id="extra-videoSkipSeconds"
            name="videoSkipSeconds"
            className="form-select form-select-sm w-auto extra-select"
            value={settings.videoSkipSeconds}
            onChange={(event) => updateSettings.mutate({ videoSkipSeconds: Number(event.target.value) })}
          >
            {[5, 10, 15, 30].map((seconds) => (
              <option key={seconds} value={seconds}>{seconds} seconds</option>
            ))}
          </select>
        </div>
      </ExtraGroup>
      <ExtraGroup group="browsing">
        {toggles('browsing')}
        <div className="list-group-item flex items-center gap-3">
          <RowIcon icon={Columns3} />
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
            className="form-select form-select-sm w-auto extra-select"
            value={settings.maxGridColumns}
            onChange={(event) => updateSettings.mutate({ maxGridColumns: Number(event.target.value) })}
          >
            <option value={0}>Automatic</option>
            {Array.from({ length: 11 }, (_, index) => index + 2).map((count) => (
              <option key={count} value={count}>{count}</option>
            ))}
          </select>
        </div>
      </ExtraGroup>
      {lockAvailable() ? (
        <ExtraGroup group="privacy">
          <AppLockSetting />
        </ExtraGroup>
      ) : null}
      <ExtraGroup group="data">
        <AutomaticTagging />
        <TrashToggle />
        <CacheLimit />
        {toggles('data')}
      </ExtraGroup>
      {error ? (
        <div className="text-destructive text-sm mt-2">{error}</div>
      ) : null}
    </div>
  );
}
