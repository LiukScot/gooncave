import { AubergineIcon } from '@/components/icons/AubergineIcon';

export function GamesView() {
  return (
    <div className="row g-4">
      <div className="col-12">
        <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
          <div className="card-body flex flex-col items-start gap-2">
            <AubergineIcon className="size-6 text-muted-foreground" />
            <h2 className="h6 mb-0">Games</h2>
            <p className="text-muted-foreground text-sm mb-0">
              Games are coming soon.
            </p>
            <span className="badge bg-secondary">Coming soon</span>
          </div>
        </div>
      </div>
    </div>
  );
}
