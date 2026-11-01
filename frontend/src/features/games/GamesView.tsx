import { AubergineIcon } from '@/components/icons/AubergineIcon';
import { PageTitle } from '@/features/shell/PageTitle';

export function GamesView() {
  return (
    <div className="page-chrome">
      <PageTitle icon={<AubergineIcon className="page-title-icon" />}>
        Games
      </PageTitle>
      <div className="coming-soon">
        <p className="coming-soon-tape">
          <span>Coming soon</span>
        </p>
      </div>
    </div>
  );
}
