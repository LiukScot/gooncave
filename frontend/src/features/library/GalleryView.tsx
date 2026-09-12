import { Eye, EyeOff } from 'lucide-react';

import { TagSearchInput } from './TagSearchInput';
import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { FileItem, Folder } from '@/api';

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
  /** Hide files already read. Only offered, and only applied, in random order. */
  galleryUnreadOnly: boolean;
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
  onUnreadOnlyToggle: () => void;
  /** Forget every read file and start the library over. */
  onReadReset: () => void;
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
  galleryUnreadOnly,
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
  onUnreadOnlyToggle,
  onReadReset,
  onFileOpen,
  onLoadMore
}: GalleryViewProps) {
  const unreadActive = gallerySort === 'random' && galleryUnreadOnly;
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
              <label
                className="text-muted-foreground text-sm"
                htmlFor="gallery-tag-search"
              >
                Search for tags:
              </label>
              <TagSearchInput
                value={galleryTagInput}
                onChange={onTagInputChange}
                placeholder="tags · ~either · -not · score:>5"
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
            {gallerySort === 'random' ? (
              <>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group flex items-center gap-2">
                  <button
                    type="button"
                    className={`btn btn-sm btn-${galleryUnreadOnly ? 'primary' : 'outline-light'} flex items-center gap-2`}
                    aria-pressed={galleryUnreadOnly}
                    onClick={onUnreadOnlyToggle}
                  >
                    {galleryUnreadOnly ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                    Unread only
                  </button>
                </div>
              </>
            ) : null}
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

          {galleryFiles.length === 0 &&
          unreadActive &&
          !galleryPageState.loading ? (
            <div className="flex flex-col items-center gap-3 py-5 text-center">
              <p className="text-muted-foreground mb-0">
                You have read everything here.
              </p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onReadReset}
              >
                Start over
              </button>
            </div>
          ) : galleryFiles.length === 0 ? (
            <p className="text-muted-foreground">
              {galleryPageState.loading
                ? 'Loading files…'
                : selectedGalleryFolder
                  ? 'No files in this folder yet. Upload into it from the folder card view.'
                  : 'No files yet. Upload into a folder card or add another folder to start auto-scan.'}
            </p>
          ) : (
            <>
              <VirtualGalleryMasonry
                files={galleryFiles}
                voteSystemEnabled={voteSystemEnabled}
                markReadOnScrollPast={unreadActive}
                onFileOpen={onFileOpen}
              />
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
