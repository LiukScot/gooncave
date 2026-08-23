import { ChevronDown, ChevronUp } from 'lucide-react';
import React from 'react';

import {
  basenameFromPath,
  fileTypeFromPath,
  formatDateTime,
  formatDuration,
  formatSizeMb
} from './utils';

import { API_BASE, type FileItem } from '@/api';

interface Props {
  file: FileItem | null;
  direction: 'prev' | 'next';
}

export function FileDetailPreview({
  file,
  direction
}: Props): React.ReactElement {
  if (!file) {
    return (
      <div
        className={`file-detail-panel file-detail-panel-preview file-detail-panel-${direction}`}
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      className={`file-detail-panel file-detail-panel-preview file-detail-panel-${direction}`}
      aria-hidden={!file}
    >
      <div
        className={`file-detail-preview-shell file-detail-layer text-foreground${file.mediaType === 'VIDEO' ? ' is-video' : ''}`}
      >
        <div
          className="file-detail-media-wrap file-detail-media-wrap-preview"
          style={
            {
              // Same shape it will have once it becomes the active file, so
              // swiping onto it does not resize the picture.
              '--file-detail-aspect':
                file.width && file.height
                  ? `${file.width} / ${file.height}`
                  : '4 / 3'
            } as React.CSSProperties
          }
        >
          {/* Thumbnail, never the original: these off-screen neighbours are
              decorative and used to pull the full file (three per open, more
              on every swipe), which is unusable on a metered connection. */}
          {/* Not lazy: these panels sit outside the viewport, and in
              fullscreen they are display:none, so a lazy image would never
              load. Fetching the neighbours' thumbnails up front is what lets
              a swipe paint instantly instead of waiting on the network. */}
          {file.thumbUrl ? (
            <img
              src={`${API_BASE}${file.thumbUrl}`}
              alt=""
              className="file-detail-media"
              decoding="async"
            />
          ) : null}
          <button
            className="file-detail-fullscreen-btn file-detail-preview-control"
            type="button"
            aria-hidden="true"
            tabIndex={-1}
          >
            <svg
              className="file-detail-fullscreen-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3H5a2 2 0 0 0-2 2v3" />
              <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
              <path d="M3 16v3a2 2 0 0 0 2 2h3" />
              <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </button>
        </div>

        <div className="container file-detail-body file-detail-preview-body">
          <div className="file-detail-section mb-4">
            <div className="file-detail-section-head">
              <div className="uppercase font-semibold file-detail-section-title">
                File info
              </div>
              <div className="file-detail-section-actions">
                <button
                  className="btn btn-outline-light btn-sm file-detail-download-button file-detail-icon-button file-detail-preview-control"
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <svg
                    className="file-detail-download-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3v10" />
                    <path d="M8 9l4 4 4-4" />
                    <path d="M5 21h14" />
                  </svg>
                  <span className="file-detail-button-text">Download</span>
                </button>
                <div
                  className="file-detail-vote file-detail-preview-control"
                  aria-hidden="true"
                >
                  <button
                    className="file-detail-vote-button"
                    type="button"
                    tabIndex={-1}
                  >
                    <ChevronUp className="file-detail-vote-icon" />
                  </button>
                  <button
                    className="file-detail-vote-button"
                    type="button"
                    tabIndex={-1}
                  >
                    <ChevronDown className="file-detail-vote-icon" />
                  </button>
                </div>
                <button
                  className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button file-detail-preview-control"
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <svg
                    className="file-detail-delete-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M6 6l1 14h10l1-14" />
                    <path d="M10 11v6" />
                    <path d="M14 11v6" />
                  </svg>
                  <span className="file-detail-button-text">Delete file</span>
                </button>
              </div>
            </div>
            <div className="text-muted-foreground text-sm">
              <span className="font-semibold file-detail-label">
                File name:
              </span>{' '}
              {basenameFromPath(file.path) || file.path}
              <br />
              {formatDuration(file.durationMs)}
              {file.durationMs ? <br /> : null}
              <span className="font-semibold file-detail-label">
                Type:
              </span>{' '}
              {fileTypeFromPath(file.path, file.mediaType)}
              <br />
              <span className="font-semibold file-detail-label">
                Size:
              </span>{' '}
              {formatSizeMb(file.sizeBytes)}
              {file.width && file.height
                ? ` (${file.width}×${file.height})`
                : ''}
              <br />
              <span className="font-semibold file-detail-label">
                Modified:
              </span>{' '}
              {formatDateTime(file.mtime)}
            </div>
          </div>

          <div className="file-detail-section-divider" />

          <div className="file-detail-section mb-4">
            <div className="file-detail-section-head">
              <div className="uppercase font-semibold file-detail-section-title">
                Tags
              </div>
              <div className="flex gap-2">
                <button
                  className="btn btn-outline-light btn-sm file-detail-refresh-button file-detail-icon-button file-detail-preview-control"
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <svg
                    className="file-detail-refresh-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  <span className="file-detail-button-text">Refresh</span>
                </button>
              </div>
            </div>
            <div className="text-muted-foreground text-sm file-detail-preview-copy">
              Tags load when this file becomes active.
            </div>
          </div>

          <div className="file-detail-section-divider" />

          <div className="file-detail-section mb-4">
            <div className="file-detail-section-head">
              <div className="uppercase font-semibold file-detail-section-title">
                Sauces
              </div>
              <button
                className="btn btn-outline-light btn-sm file-detail-scan-button file-detail-icon-button file-detail-preview-control"
                type="button"
                tabIndex={-1}
                aria-hidden="true"
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
                <span className="file-detail-button-text">Scan</span>
              </button>
            </div>
            <div className="text-muted-foreground text-sm file-detail-preview-copy">
              Match results load when this file becomes active.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
