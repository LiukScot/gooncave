import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { OfflineChip } from '@/features/shell/OfflineChip';

export function SettingsSubpage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page-chrome">
      <div className="settings-subpage-back mb-3">
        <Link to="/app/settings" className="btn btn-link">
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back to Settings
        </Link>
      </div>
      <div className="settings-subpage-head flex items-center gap-2 mb-4">
        <h1 className="uppercase font-semibold file-detail-section-title">
          {title}
        </h1>
        <OfflineChip />
      </div>
      {children}
    </div>
  );
}
