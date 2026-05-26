import React from 'react';
import { API_BASE, type FileItem } from '@/api';
import { basenameFromPath, fileTypeFromPath, formatDateTime, formatSizeMb } from './utils';

interface Props {
  file: FileItem | null;
  direction: 'prev' | 'next';
}

export function FileDetailPreview({ file, direction }: Props): React.ReactElement {
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
        <div className="container file-detail-back-bar">
          <button
            className="file-detail-back-btn file-detail-preview-control"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
          >
            <svg
              className="file-detail-back-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {direction === 'prev' ? 'Previous file' : 'Next file'}
          </button>
          <div className="flex items-center gap-2 ml-auto file-detail-sequence-controls">
            <button
              className="btn btn-outline-secondary btn-sm file-detail-preview-control"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
            >
              ‹ Prev
            </button>
            <button
              className="btn btn-outline-secondary btn-sm file-detail-preview-control"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
            >
              Next ›
            </button>
          </div>
        </div>

        <div className="file-detail-media-wrap file-detail-media-wrap-preview">
          {file.mediaType === 'VIDEO' ? (
            <video
              src={`${API_BASE}/files/${file.id}/content`}
              controls
              loop
              playsInline
              preload="metadata"
              className="file-detail-media"
            />
          ) : (
            <img
              src={`${API_BASE}/files/${file.id}/content`}
              alt={file.path}
              className="file-detail-media"
            />
          )}
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
              <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
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
                <button
                  className="btn btn-outline-warning btn-sm file-detail-favorite-button file-detail-icon-button file-detail-preview-control"
                  type="button"
                  tabIndex={-1}
                  aria-hidden="true"
                >
                  <svg
                    className="file-detail-favorite-icon file-detail-favorite-icon-outline"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                  </svg>
                  <span className="file-detail-button-text">Favorite</span>
                </button>
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
              <span className="font-semibold file-detail-label">File name:</span>{' '}
              {basenameFromPath(file.path) || file.path}
              <br />
              {file.durationMs ? `${(file.durationMs / 1000).toFixed(1)}s` : ''}
              {file.durationMs ? <br /> : null}
              <span className="font-semibold file-detail-label">Type:</span>{' '}
              {fileTypeFromPath(file.path, file.mediaType)}
              <br />
              <span className="font-semibold file-detail-label">Size:</span>{' '}
              {formatSizeMb(file.sizeBytes)}
              {file.width && file.height ? ` (${file.width}×${file.height})` : ''}
              <br />
              <span className="font-semibold file-detail-label">Modified:</span>{' '}
              {formatDateTime(file.mtime)}
            </div>
          </div>

          <div className="file-detail-section-divider" />

          <div className="file-detail-section mb-4">
            <div className="file-detail-section-head">
              <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
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
              <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
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
