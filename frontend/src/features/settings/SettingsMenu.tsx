import { Link } from '@tanstack/react-router';
import {
  ChevronRight,
  Copy,
  EyeOff,
  FolderSync,
  Keyboard,
  Palette,
  Rss,
  ScanSearch,
  Settings,
  Sparkles,
  Trash2,
  UsersRound
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';


type SettingsPage = {
  to:
    | '/app/settings/appearance'
    | '/app/settings/shortcuts'
    | '/app/settings/accounts'
    | '/app/settings/file-sources'
    | '/app/settings/duplicates'
    | '/app/settings/subscriptions'
    | '/app/settings/blacklist'
    | '/app/settings/sync'
    | '/app/settings/trash'
    | '/app/settings/extra';
  label: string;
  description: string;
  icon: LucideIcon;
};

// Every page is in exactly one section, so a setting has one place to look.
const SETTINGS_SECTIONS: { title: string; items: SettingsPage[] }[] = [
  {
    title: 'Interface',
    items: [
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
      }
    ]
  },
  {
    title: 'Sources',
    items: [
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
      }
    ]
  },
  {
    title: 'Library',
    items: [
      {
        to: '/app/settings/sync',
        label: 'Backup & sync',
        description: 'Share your library with your other devices, save a backup or move from an old server.',
        icon: FolderSync
      },
      {
        to: '/app/settings/trash',
        label: 'Trash',
        description: 'Restore deleted files before they go for good.',
        icon: Trash2
      },
      {
        to: '/app/settings/duplicates',
        label: 'Matching images',
        description: 'Choose what happens when the same image is found more than once.',
        icon: Copy
      }
    ]
  },
  {
    title: 'Advanced',
    items: [
      {
        to: '/app/settings/extra',
        label: 'Extra',
        description: 'Turn optional features on or off.',
        icon: Sparkles
      }
    ]
  }
];

export function SettingsMenu() {
  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title page-title mb-4">
        <Settings className="page-title-icon" aria-hidden="true" />
        Settings
      </h1>
      {SETTINGS_SECTIONS.map(({ title, items }) => (
        <section key={title} aria-labelledby={`settings-${title}`} className="mb-6">
          <h2
            id={`settings-${title}`}
            className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {title}
          </h2>
          <div className="list-group list-group-segmented">
            {items.map(({ to, label, description, icon: Icon }) => (
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
        </section>
      ))}
    </div>
  );
}
