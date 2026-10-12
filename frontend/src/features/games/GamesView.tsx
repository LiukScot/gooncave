import { AubergineIcon } from '@/components/icons/AubergineIcon';

export function GamesView() {
  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title page-title mb-4">
        <AubergineIcon className="page-title-icon" />
        Games
      </h1>
      <div className="coming-soon">
        <p className="coming-soon-tape">
          <span>Coming soon</span>
        </p>
      </div>
    </div>
  );
}
