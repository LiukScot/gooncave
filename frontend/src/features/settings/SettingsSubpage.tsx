import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { OfflineChip } from '@/features/shell/OfflineChip';

export function SettingsSubpage({
  title,
  back,
  children
}: {
  title: string;
  /** Where the page came from, when that is not the Settings list. */
  back?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page-chrome">
      {back ?? (
        <Link to="/app/settings" className="btn btn-link mb-3">
          <ChevronLeft className="size-4" aria-hidden="true" />
          Back to Settings
        </Link>
      )}
      <div className="flex items-center gap-2 mb-4">
        <h1 className="uppercase font-semibold file-detail-section-title">
          {title}
        </h1>
        <OfflineChip />
      </div>
      {children}
    </div>
  );
}
