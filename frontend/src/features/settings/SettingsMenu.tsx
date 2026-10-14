import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  Copy,
  EyeOff,
  Keyboard,
  Palette,
  Rss,
  ScanSearch,
  Settings,
  Sparkles,
  UsersRound
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';


const SETTINGS_ITEMS: {
  to:
    | '/app/settings/file-sources'
    | '/app/settings/duplicates'
    | '/app/settings/accounts'
    | '/app/settings/subscriptions'
    | '/app/settings/shortcuts'
    | '/app/settings/blacklist'
    | '/app/settings/appearance'
    | '/app/settings/extra';
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    to: '/app/settings/appearance',
    label: 'Appearance',
    description: 'Pick light or dark, an accent colour and a style.',
    icon: Palette
  },
  {
    to: '/app/settings/shortcuts',
    label: 'Shortcuts',
    description: 'Change the keys that drive the detail view and dialogs.',
    icon: Keyboard
  },
  {
    to: '/app/settings/accounts',
    label: 'Accounts',
    description: 'Set up your accounts and sync favorites.',
    icon: UsersRound
  },
  {
    to: '/app/settings/file-sources',
    label: 'File sources',
    description: 'Find the sources of your files.',
    icon: ScanSearch
  },
  {
    to: '/app/settings/duplicates',
    label: 'Matching images',
    description: 'Choose what happens when the same image is found more than once.',
    icon: Copy
  },
  {
    to: '/app/settings/subscriptions',
    label: 'Subscriptions',
    description: 'Follow tags locally and FurAffinity artists remotely.',
    icon: Rss
  },
  {
    to: '/app/settings/blacklist',
    label: 'Blacklist',
    description: 'Hide files and booru results by tag.',
    icon: EyeOff
  },
  {
    to: '/app/settings/extra',
    label: 'Extra',
    description: 'Turn optional features on or off.',
    icon: Sparkles
  }
];

export function SettingsMenu() {

  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title page-title mb-4">
        <Settings className="page-title-icon" aria-hidden="true" />
        Settings
      </h1>
      <div className="list-group list-group-segmented">
        {SETTINGS_ITEMS.map(({ to, label, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="list-group-item flex items-center gap-3"
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


    </div>
  );
}
