import { ChevronUp, Play } from 'lucide-react';

import type { FileItem, Folder } from '@/api';
import { API_BASE } from '@/api';
import { formatDuration } from '@/lib/format';

const THUMB_SIZE = 220;

export type FetchState = { loading: boolean; error: string | null };
export type GallerySort = 'rated' | 'mtime_desc' | 'mtime_asc' | 'random';

/** Minimal shape of folderDetailsById values used in this view */
export type FolderDetail = { filterLabel?: string };

export interface GalleryViewProps {
  // --- state ---
  galleryFolderId: string;
  galleryFiles: FileItem[];
  galleryHasMore: boolean;
  galleryPageState: FetchState;
  gallerySort: GallerySort;
  /** Gates the "Rated" sort and the per-card score chip. */
  voteSystemEnabled: boolean;
  galleryFilters: { photos: boolean; videos: boolean };
  isGalleryFilterOpen: boolean;
  galleryTagInput: string;
  galleryFilterLabel: string;
  galleryCountText: string;
  selectedGalleryFolder: Folder | null;
  orderedFolders: Folder[];
  folderDetailsById: Map<string, FolderDetail>;

  // --- refs ---
  galleryFilterRef: React.RefObject<HTMLDivElement | null>;
  galleryLoadMoreRef: React.RefObject<HTMLDivElement | null>;

  // --- callbacks ---
  onFolderChange: (folderId: string) => void;
  onTagInputChange: (value: string) => void;
  onTagQueryClear: () => void;
  onFilterChange: (
    patch: Partial<{ photos: boolean; videos: boolean }>
  ) => void;
  onFilterClose: () => void;
  onFilterOpenToggle: () => void;
  onSortChange: (sort: GallerySort) => void;
  onFileOpen: (file: FileItem) => void;
  onLoadMore: () => void;
}

export function GalleryView({
  galleryFolderId,
  galleryFiles,
  galleryHasMore,
  galleryPageState,
  gallerySort,
  voteSystemEnabled,
  galleryFilters,
  isGalleryFilterOpen,
  galleryTagInput,
  galleryFilterLabel,
  galleryCountText,
  selectedGalleryFolder,
  orderedFolders,
  folderDetailsById,
  galleryFilterRef,
  galleryLoadMoreRef,
  onFolderChange,
  onTagInputChange,
  onTagQueryClear,
  onFilterChange,
  onFilterClose,
  onFilterOpenToggle,
  onSortChange,
  onFileOpen,
  onLoadMore
}: GalleryViewProps) {
  return (
    <div
      className="col-12"
      onPointerDownCapture={(event) => {
        if (!isGalleryFilterOpen) return;
        const target = event.target as Node;
        if (galleryFilterRef.current?.contains(target)) return;
        onFilterClose();
      }}
    >
      <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
        <div className="card-body">
          {/* Controls row */}
          <div className="gallery-controls flex flex-wrap items-center mb-2">
            {/* Search */}
            <div className="gallery-control-group gallery-control-search flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">
                Search for tags:
              </span>
              <input
                className="form-control form-control-sm bg-background text-foreground border-secondary gallery-control-search-input"
                placeholder="Filter by tags (space or comma separated)"
                value={galleryTagInput}
                onChange={(event) => onTagInputChange(event.target.value)}
              />
              {galleryTagInput ? (
                <button
                  className="btn btn-outline-light btn-sm"
                  onClick={() => {
                    onTagInputChange('');
                    onTagQueryClear();
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <span className="gallery-control-separator" aria-hidden="true" />
            {/* Folder picker */}
            <div className="gallery-control-group flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Folder:</span>
              <select
                className="form-select form-select-sm bg-background text-foreground border-secondary gallery-folder-select"
                value={galleryFolderId}
                onChange={(event) => onFolderChange(event.target.value)}
              >
                <option value="">All folders</option>
                {orderedFolders.map((folder) => {
                  const folderInfo = folderDetailsById.get(folder.id);
                  return (
                    <option key={folder.id} value={folder.id}>
                      {folderInfo?.filterLabel ?? folder.path}
                    </option>
                  );
                })}
              </select>
            </div>
            <span className="gallery-control-separator" aria-hidden="true" />
            {/* Sort */}
            <div className="gallery-control-group flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Order by:</span>
              <div className="btn-group btn-group-sm" role="group">
                {voteSystemEnabled ? (
                  <button
                    className={`btn btn-${gallerySort === 'rated' ? 'primary' : 'outline-light'}`}
                    onClick={() => onSortChange('rated')}
                  >
                    Rated
                  </button>
                ) : null}
                <button
                  className={`btn btn-${gallerySort === 'mtime_desc' ? 'primary' : 'outline-light'}`}
                  onClick={() => onSortChange('mtime_desc')}
                >
                  Newest
                </button>
                <button
                  className={`btn btn-${gallerySort === 'mtime_asc' ? 'primary' : 'outline-light'}`}
                  onClick={() => onSortChange('mtime_asc')}
                >
                  Oldest
                </button>
                <button
                  className={`btn btn-${gallerySort === 'random' ? 'primary' : 'outline-light'}`}
                  onClick={() => onSortChange('random')}
                >
                  Random
                </button>
              </div>
            </div>
            <span className="gallery-control-separator" aria-hidden="true" />
            {/* Filters popover */}
            <div className="gallery-control-group flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Filters:</span>
              <div className="dropdown" ref={galleryFilterRef}>
                <button
                  className="btn btn-outline-light btn-sm dropdown-toggle"
                  type="button"
                  aria-expanded={isGalleryFilterOpen}
                  onClick={onFilterOpenToggle}
                >
                  {galleryFilterLabel}
                </button>
                {isGalleryFilterOpen ? (
                  <button
                    type="button"
                    className="dropdown-backdrop"
                    aria-label="Close filters"
                    onClick={onFilterOpenToggle}
                  />
                ) : null}
                <div
                  className={`dropdown-menu dropdown-menu-dark p-4${isGalleryFilterOpen ? ' show' : ''}`}
                >
                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="gallery-filter-photos"
                      name="gallery-filter-photos"
                      checked={galleryFilters.photos}
                      onChange={() =>
                        onFilterChange({ photos: !galleryFilters.photos })
                      }
                    />
                    <label
                      className="form-check-label"
                      htmlFor="gallery-filter-photos"
                    >
                      Photos
                    </label>
                  </div>
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="gallery-filter-videos"
                      name="gallery-filter-videos"
                      checked={galleryFilters.videos}
                      onChange={() =>
                        onFilterChange({ videos: !galleryFilters.videos })
                      }
                    />
                    <label
                      className="form-check-label"
                      htmlFor="gallery-filter-videos"
                    >
                      Videos
                    </label>
                  </div>
                </div>
              </div>
            </div>
            <span className="gallery-control-separator" aria-hidden="true" />
            {/* Count */}
            <div className="gallery-control-group ml-auto">
              <span className="text-muted-foreground text-sm">
                {galleryCountText} items
              </span>
            </div>
          </div>

          <hr className="border-secondary my-4" />

          {galleryPageState.error ? (
            <div className="text-destructive text-sm mb-2">
              Gallery: {galleryPageState.error}
            </div>
          ) : null}

          {galleryFiles.length === 0 ? (
            <p className="text-muted-foreground">
              {galleryPageState.loading
                ? 'Loading files…'
                : selectedGalleryFolder
                  ? 'No files in this folder yet. Upload into it from the folder card view.'
                  : 'No files yet. Upload into a folder card or add another folder to start auto-scan.'}
            </p>
          ) : (
            <>
              <div className="gallery-grid">
                {galleryFiles.map((file) => {
                  // Known dimensions let the box hug the picture instead of
                  // the grid cell, so the corner chips sit on the art rather
                  // than on the bars object-fit leaves.
                  const thumbRatio =
                    file.thumbUrl && file.width && file.height
                      ? file.width / file.height
                      : null;
                  return (
                    <div key={file.id} className="min-w-0">
                      <button
                        type="button"
                        className="h-full border-0 bg-transparent p-0 text-left w-full"
                        data-test-id="file-card"
                        aria-label={`Open ${file.path}${
                          file.mediaType === 'VIDEO' ? ' (video)' : ''
                        }${
                          voteSystemEnabled && file.voteScore > 0
                            ? `, score ${file.voteScore}`
                            : ''
                        }`}
                        onClick={() => onFileOpen(file)}
                      >
                        <div
                          className={`gallery-thumb${thumbRatio ? ' is-sized' : ''}`}
                          style={
                            {
                              '--gallery-thumb-max': `${THUMB_SIZE}px`,
                              ...(thumbRatio
                                ? { '--gallery-thumb-ratio': thumbRatio }
                                : {})
                            } as React.CSSProperties
                          }
                        >
                          {file.thumbUrl ? (
                            <img
                              src={`${API_BASE}${file.thumbUrl}`}
                              alt={file.path}
                              width={file.width ?? THUMB_SIZE}
                              height={file.height ?? THUMB_SIZE}
                              className="gallery-thumb-img rounded"
                              loading="lazy"
                              decoding="async"
                              fetchPriority="low"
                            />
                          ) : (
                            <div
                              className="rounded flex items-center justify-center bg-background"
                              style={{ height: THUMB_SIZE }}
                            >
                              <span className="text-muted-foreground text-sm">
                                {file.mediaType.toLowerCase()}
                              </span>
                            </div>
                          )}
                          {file.mediaType === 'VIDEO' && file.thumbUrl ? (
                            <Play
                              aria-hidden="true"
                              fill="currentColor"
                              className="absolute inset-0 m-auto size-10 rounded-full bg-background/70 p-2 text-foreground"
                            />
                          ) : null}
                          {file.durationMs ? (
                            <span className="gallery-chip left-2">
                              {formatDuration(file.durationMs)}
                            </span>
                          ) : null}
                          {voteSystemEnabled && file.voteScore > 0 ? (
                            <span
                              data-test-id="card-score"
                              className="gallery-chip right-2"
                            >
                              <ChevronUp
                                className="size-3"
                                aria-hidden="true"
                              />
                              {file.voteScore}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
              {galleryHasMore ? (
                <div className="flex justify-center mt-4">
                  <button
                    className="btn btn-outline-light btn-sm"
                    onClick={onLoadMore}
                    disabled={galleryPageState.loading}
                  >
                    {galleryPageState.loading ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              ) : null}
              <div ref={galleryLoadMoreRef} className="gallery-load-sentinel" />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
