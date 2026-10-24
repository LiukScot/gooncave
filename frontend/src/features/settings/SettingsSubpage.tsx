import { Link, useRouter } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEdgeSwipeBack } from '@/lib/edgeSwipeBack';

export function SettingsSubpage({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  const router = useRouter();
  useEdgeSwipeBack(() => router.history.canGoBack());
  return (
    <div className="page-chrome">
      <Link to="/app/settings" className="btn btn-link mb-3">
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back to Settings
      </Link>
      <h1 className="uppercase font-semibold file-detail-section-title mb-4">
        {title}
      </h1>
      {children}
    </div>
  );
}
