import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  Copy,
  Folder,
  Heart,
  LogOut,
  RefreshCw,
  Sparkles,
  Tags,
  UserRound
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useAppShellContext } from '@/features/shell/AppShell';

const SETTINGS_ITEMS: {
  to:
    | '/app/settings/folders'
    | '/app/settings/sync'
    | '/app/settings/duplicates'
    | '/app/settings/favorites'
    | '/app/settings/tags'
    | '/app/settings/extra';
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    to: '/app/settings/folders',
    label: 'Folders',
    description: 'Set up your local folders.',
    icon: Folder
  },
  {
    to: '/app/settings/sync',
    label: 'Sync',
    description: 'Find the sources of your files.',
    icon: RefreshCw
  },
  {
    to: '/app/settings/duplicates',
    label: 'Duplicates',
    description: 'Scan the library and resolve duplicate files.',
    icon: Copy
  },
  {
    to: '/app/settings/favorites',
    label: 'Favorites accounts',
    description: 'Set up your accounts and sync favorites.',
    icon: Heart
  },
  {
    to: '/app/settings/tags',
    label: 'Tags',
    description: 'Merge similar tags and keep the tag database current.',
    icon: Tags
  },
  {
    to: '/app/settings/extra',
    label: 'Extra',
    description: 'Turn optional features on or off.',
    icon: Sparkles
  }
];

export function SettingsMenu() {
  const { authUser, logout, logoutPending, logoutError } = useAppShellContext();

  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title mb-4">
        Settings
      </h1>
      <div className="list-group">
        {SETTINGS_ITEMS.map(({ to, label, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="list-group-item flex items-center gap-3 hover:bg-accent transition-colors"
          >
            <Icon
              className="size-5 text-muted-foreground shrink-0"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0">
              <span className="block font-medium">{label}</span>
              <span className="block text-muted-foreground text-xs">
                {description}
              </span>
            </span>
            <ChevronRight
              className="size-4 text-muted-foreground shrink-0"
              aria-hidden="true"
            />
          </Link>
        ))}
      </div>

      <div className="list-group mt-6">
        <div className="list-group-item flex items-center gap-3">
          <UserRound
            className="size-5 text-muted-foreground shrink-0"
            aria-hidden="true"
          />
          <span className="flex-1 min-w-0 text-muted-foreground text-sm">
            Signed in as {authUser.username}
          </span>
        </div>
        <button
          type="button"
          className="list-group-item flex items-center gap-3 hover:bg-accent transition-colors w-full text-left bg-transparent border-0 cursor-pointer text-destructive"
          // fire and forget: AppShell tracks completion/errors via
          // logoutPending/logoutError, rendered right below
          onClick={() => void logout()}
          disabled={logoutPending}
        >
          <LogOut className="size-5 shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0 font-medium">
            {logoutPending ? 'Logging out…' : 'Logout'}
          </span>
        </button>
        {logoutError ? (
          <div className="list-group-item text-destructive text-sm">
            {logoutError}
          </div>
        ) : null}
      </div>
    </div>
  );
}
