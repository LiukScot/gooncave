import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

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
      <h1 className="uppercase font-semibold file-detail-section-title mb-4">
        {title}
      </h1>
      {children}
    </div>
  );
}
