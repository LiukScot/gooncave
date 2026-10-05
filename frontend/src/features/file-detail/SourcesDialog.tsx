import { Copy, Globe2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ProviderHighlight, ProviderMeta } from './FileDetailPanel';

import type { FavoriteSourceLink } from '@/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format';
import { scrollSidewaysOnWheel } from '@/lib/scrollSidewaysOnWheel';

// Logos without a background, shipped in public/site-logos (see its
// README for sources and licenses), by the domain a link points at.
const BUNDLED_LOGOS: Record<string, string> = {
  'e621.net': 'e621.svg',
  'e926.net': 'e621.svg',
  'donmai.us': 'danbooru.svg',
  'derpibooru.org': 'derpibooru.svg',
  'weasyl.com': 'weasyl.svg',
  'furaffinity.net': 'furaffinity.png',
  'inkbunny.net': 'inkbunny.png',
  'bsky.app': 'bluesky.svg',
  'x.com': 'x.svg',
  'twitter.com': 'x.svg',
  'pixiv.net': 'pixiv.svg',
  'deviantart.com': 'deviantart.svg',
  'tumblr.com': 'tumblr.svg',
  'newgrounds.com': 'newgrounds.svg',
  'artstation.com': 'artstation.svg',
  'patreon.com': 'patreon.svg'
};

const bundledLogo = (host: string): string | null => {
  const bare = host.replace(/^www\./, '').toLowerCase();
  const domain = Object.keys(BUNDLED_LOGOS).find(
    (known) => bare === known || bare.endsWith(`.${known}`)
  );
  return domain ? `/site-logos/${BUNDLED_LOGOS[domain]}` : null;
};

/**
 * A site's logo. A bundled one has no background; for any other site the
 * largest icon it publishes is the next best (the touch icon is drawn for
 * a home screen, the favicon for a tab), and the globe stands in when
 * nothing loads.
 */
export function SiteLogo({ url }: { url: string }) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();
  const bundled = host ? bundledLogo(host) : null;
  const candidates = host
    ? [
        ...(bundled ? [bundled] : []),
        `https://${host}/apple-touch-icon.png`,
        `https://${host}/favicon.ico`
      ]
    : [];
  const [attempt, setAttempt] = useState(0);
  const src = candidates[attempt];
  return (
    <span className="file-detail-source-logo" aria-hidden="true">
      {src ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setAttempt((current) => current + 1)}
        />
      ) : (
        <Globe2 />
      )}
    </span>
  );
}

export type SourceCard = {
  key: string;
  url: string;
  /** What found the link: a favourite, or the scan provider. */
  kind: string;
  siteName: string;
  detail: string;
};

/**
 * One card per link. Scan matches keep their place ahead of favourites, so
 * a favourite that arrives later does not move the cards already shown; a
 * scan that found a favourited post is dropped for the favourite's card.
 */
export const sourceCards = (
  highlights: readonly ProviderHighlight[],
  favoriteSources: readonly FavoriteSourceLink[]
): SourceCard[] => {
  const favoriteUrls = new Set(favoriteSources.map((source) => source.sourceUrl));
  return [
    ...highlights
      .filter((item) => !favoriteUrls.has(item.sourceUrl))
      .map((item) => ({
        key: item.id,
        url: item.sourceUrl,
        kind: item.provider,
        siteName: item.sourceName,
        detail: item.score !== null ? `score ${item.score}` : 'score n/a'
      })),
    ...favoriteSources.map((source) => ({
      key: `favorite-${source.sourceUrl}`,
      url: source.sourceUrl,
      kind: 'Favorited post',
      siteName: source.siteName,
      detail: 'Open post'
    }))
  ];
};

const copySource = async (card: SourceCard): Promise<void> => {
  try {
    await navigator.clipboard.writeText(card.url);
    toast.success(`${card.siteName} link copied`);
  } catch {
    toast.error('Could not copy the post link');
  }
};

/**
 * Every link the file was found at, one card per site, with the scan
 * status and the button that runs a new scan underneath.
 */
export function SourcesDialog({
  open,
  onOpenChange,
  highlights,
  favoriteSources,
  providerMeta,
  nextAutoScanText,
  emptyLabel,
  scanBusy,
  scanError,
  onRunAllProviders
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  highlights: readonly ProviderHighlight[];
  favoriteSources: readonly FavoriteSourceLink[];
  providerMeta: ProviderMeta | null;
  nextAutoScanText: string;
  emptyLabel: string;
  scanBusy: boolean;
  scanError: string | null;
  onRunAllProviders: () => void;
}) {
  const cards = sourceCards(highlights, favoriteSources);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="file-detail-sources-title">Sources</DialogTitle>
        </DialogHeader>

        {cards.length === 0 ? (
          <div className="file-detail-topmatches-empty text-muted-foreground text-sm">
            {emptyLabel}
          </div>
        ) : (
          <div
            className="file-detail-source-carousel"
            ref={scrollSidewaysOnWheel}
          >
            {cards.map((card) => (
              <div key={card.key} className="file-detail-source-card">
                <a
                  className="file-detail-source-card-link"
                  href={card.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${card.detail}: ${card.siteName}`}
                >
                  <SiteLogo url={card.url} />
                  <span className="file-detail-source-card-body">
                    <span className="text-muted-foreground text-xs uppercase">
                      {card.kind}
                    </span>
                    <span className="font-semibold truncate" title={card.siteName}>
                      {card.siteName}
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {card.detail}
                    </span>
                  </span>
                </a>
                <span className="file-detail-source-card-actions">
                  <button
                    type="button"
                    className="file-detail-source-copy"
                    aria-label={`Copy link to ${card.siteName}`}
                    title="Copy link"
                    onClick={() => void copySource(card)}
                  >
                    <Copy aria-hidden="true" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="file-detail-sources-scan">
          <div className="text-muted-foreground text-sm">
            <div>
              <span className="font-semibold file-detail-label">
                Provider scans:
              </span>{' '}
              {providerMeta?.hasRuns
                ? `last run ${formatDateTime(providerMeta.latestRunAt)}`
                : 'never run yet'}
            </div>
            {providerMeta?.missingProviders.length ? (
              <div>
                <span className="font-semibold file-detail-label">Missing:</span>{' '}
                {providerMeta.missingProviders.join(', ')}
              </div>
            ) : null}
            <div>
              <span className="font-semibold file-detail-label">
                Next auto-scan:
              </span>{' '}
              {nextAutoScanText}
            </div>
            {scanError ? (
              <div className="text-destructive mt-1">{scanError}</div>
            ) : null}
          </div>
          <button
            className="btn btn-outline-light btn-sm file-detail-scan-button file-detail-icon-button"
            disabled={scanBusy}
            onClick={onRunAllProviders}
            aria-label="Scan with SauceNAO and Fluffle"
            title="Scan with SauceNAO and Fluffle"
          >
            <svg
              className="file-detail-scan-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="6" />
              <path d="M16 16l5 5" />
            </svg>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
