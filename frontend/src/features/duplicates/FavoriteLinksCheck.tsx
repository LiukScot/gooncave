import { AlertTriangle, HeartPulse, LoaderCircle } from 'lucide-react';

import { useRecheckFavoriteLinks } from '@/hooks/duplicates';

export function FavoriteLinksCheck() {
  const check = useRecheckFavoriteLinks();
  const report = check.data;
  return (
    <section className="duplicate-preview" aria-live="polite">
      <div className="duplicate-section-heading">
        <div>
          <h3>Saved favorites</h3>
          <p>
            Earlier versions could join edits of one picture into a single file and
            link every edit's post to it. This asks each post for its picture and
            removes the links that do not match. The posts stay favorited on their
            sites.
          </p>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-outline-light btn-sm mb-3"
        onClick={() => check.mutate()}
        disabled={check.isPending}
      >
        {check.isPending ? (
          <>
            <LoaderCircle aria-hidden="true" /> Checking…
          </>
        ) : (
          <>
            <HeartPulse aria-hidden="true" /> Check saved favorites
          </>
        )}
      </button>
      {report ? (
        <p className="duplicate-no-changes">
          {report.removed.length === 0
            ? `Checked ${report.checked} links. None needed removing.`
            : `Checked ${report.checked} links and removed ${report.removed.length}: ${report.removed
                .map((link) => `${link.provider} #${link.remoteId}`)
                .join(', ')}.`}
          {report.unchecked > 0
            ? ` ${report.unchecked} could not be read and were left as they are; run the check again later.`
            : ''}
          {report.unresolvedFiles > 0
            ? ` ${report.unresolvedFiles} ${report.unresolvedFiles === 1 ? 'file has' : 'files have'} no matching post, so nothing was removed there.`
            : ''}
        </p>
      ) : null}
      {check.isError ? (
        <div className="duplicate-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong>The check could not finish.</strong> {check.error.message}
          </span>
        </div>
      ) : null}
    </section>
  );
}
