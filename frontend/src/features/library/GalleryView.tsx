import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, ImagePlus, RefreshCw } from 'lucide-react';
import { useRef } from 'react';

import { TagSearchInput } from './TagSearchInput';
import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { BooruSite, DuplicateGroup, FileItem } from '@/api';
import { FeatureUnavailable } from '@/features/shell/FeatureUnavailable';
import { useErrorToast } from '@/lib/useErrorToast';


export type FetchState = { loading: boolean; error: string | null };
export type GallerySort = 'rated' | 'mtime_desc' | 'mtime_asc' | 'random';

/** The same favorites sync as Settings → Accounts → Sync favorites. */
export type GalleryFavoritesSync = {
  running: boolean;
  error: string | null;
  onSync: () => void;
};

export interface GalleryViewProps {
  // --- state ---
  libraryAvailable?: boolean;
  favoritesSync?: GalleryFavoritesSync;
  /** Library root path; with it the toolbar gets a link that opens the library in the file manager. */
  openFolderRoot?: string;
  /** Adds files the person picks to the library; with it the toolbar gets an "Add files" button. */
  onAddFiles?: (files: File[]) => void;
  /** Picks from the photo library instead, where the originals can be deleted after adding. */
  onAddFromPhotos?: () => void;
  galleryFiles: FileItem[];
  duplicateGroups: DuplicateGroup[] | null;
  duplicateScanError: string | null;
  sourceSites: BooruSite[];
  galleryHasMore: boolean;
  galleryPageState: FetchState;
  gallerySort: GallerySort;
  /** Gates the "Rated" sort and the per-card score chip. */
  voteSystemEnabled: boolean;
  maxGridColumns: number;
  galleryFilters: { photos: boolean; videos: boolean };
  isGalleryFilterOpen: boolean;
  galleryTagInput: string;
  galleryFilterLabel: string;
  galleryCountText: string;

  // --- refs ---
  galleryFilterRef: React.RefObject<HTMLDivElement | null>;
  galleryLoadMoreRef: React.RefObject<HTMLDivElement | null>;

  // --- callbacks ---
  onTagInputChange: (value: string) => void;
  onTagQueryClear: () => void;
  onFilterChange: (
    patch: Partial<{ photos: boolean; videos: boolean }>
  ) => void;
  onFilterClose: () => void;
  onFilterOpenToggle: () => void;
  onSortChange: (sort: GallerySort) => void;
  onFileOpen: (file: FileItem) => void;
  onUpvote: (fileId: string) => Promise<void>;
  onLoadMore: () => void;
}

// The desktop shell catches this link and shows the folder in the file manager.
const folderUrl = (path: string) => `/open-folder?path=${encodeURIComponent(path)}`;

export function GalleryView({
  libraryAvailable = true,
  favoritesSync,
  openFolderRoot,
  onAddFiles,
  onAddFromPhotos,
  galleryFiles,
  duplicateGroups,
  duplicateScanError,
  sourceSites,
  galleryHasMore,
  galleryPageState,
  gallerySort,
  voteSystemEnabled,
  maxGridColumns,
  galleryFilters,
  isGalleryFilterOpen,
  galleryTagInput,
  galleryFilterLabel,
  galleryCountText,
  galleryFilterRef,
  galleryLoadMoreRef,
  onTagInputChange,
  onTagQueryClear,
  onFilterChange,
  onFilterClose,
  onFilterOpenToggle,
  onSortChange,
  onFileOpen,
  onUpvote,
  onLoadMore
}: GalleryViewProps) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  useErrorToast(favoritesSync?.error && `Favorites sync: ${favoritesSync.error}`, {
    action: {
      label: 'Open Accounts',
      onClick: () => void navigate({ to: '/app/settings/accounts' })
    }
  });
  useErrorToast(galleryPageState.error && `Gallery: ${galleryPageState.error}`);
  useErrorToast(
    duplicateScanError && `Duplicate stacks unavailable: ${duplicateScanError}`
  );
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
          <div className="gallery-controls flex flex-wrap items-center mb-4">
            {/* Search */}
            <div className="gallery-control-group gallery-control-search flex flex-wrap items-center gap-2">
              <label
                className="text-muted-foreground text-sm gallery-control-label"
                htmlFor="gallery-tag-search"
              >
                Search:
              </label>
              <TagSearchInput
                value={galleryTagInput}
                onChange={onTagInputChange}
                onClear={() => {
                  onTagInputChange('');
                  onTagQueryClear();
                }}
                placeholder="tags · ~either · -not · score:>5"
              />
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
              <span className="text-muted-foreground text-sm gallery-control-label">Filters:</span>
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
            {favoritesSync ? (
              <>
                <span className="gallery-control-separator" aria-hidden="true" />
                <div className="gallery-control-group flex items-center">
                  <button
                    className="btn btn-outline-light btn-sm inline-flex items-center gap-2"
                    type="button"
                    onClick={favoritesSync.onSync}
                    disabled={favoritesSync.running}
                    aria-busy={favoritesSync.running}
                  >
                    <RefreshCw
                      className={`size-4${favoritesSync.running ? ' animate-spin motion-reduce:animate-none' : ''}`}
                      aria-hidden="true"
                    />
                    {favoritesSync.running ? 'Syncing favorites…' : 'Sync favorites'}
                  </button>
                </div>
              </>
            ) : null}
            {openFolderRoot ? (
              <>
                <span className="gallery-control-separator" aria-hidden="true" />
                <a
                  className="btn btn-outline-light btn-sm inline-flex items-center gap-2 whitespace-nowrap"
                  href={folderUrl(openFolderRoot)}
                >
                  <FolderOpen className="size-4" aria-hidden="true" />
                  Open folder
                </a>
              </>
            ) : null}
            {onAddFiles ? (
              <>
                <span className="gallery-control-separator" aria-hidden="true" />
                <button
                  className="btn btn-outline-light btn-sm inline-flex items-center gap-2 whitespace-nowrap"
                  type="button"
                  onClick={() => (onAddFromPhotos ? onAddFromPhotos() : pickerRef.current?.click())}
                >
                  <ImagePlus className="size-4" aria-hidden="true" />
                  Add files
                </button>
                <input
                  ref={pickerRef}
                  className="sr-only"
                  type="file"
                  name="add-files"
                  aria-label="Choose files to add"
                  accept="image/*,video/*"
                  multiple
                  tabIndex={-1}
                  onChange={(event) => {
                    onAddFiles(Array.from(event.target.files ?? []));
                    // The same files can be picked again.
                    event.target.value = '';
                  }}
                />
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



          {galleryFiles.length === 0 && !libraryAvailable ? (
            <FeatureUnavailable feature="Folder import" />
          ) : galleryFiles.length === 0 ? (
            <div className="gallery-empty text-muted-foreground">
              {galleryPageState.loading ? <p>Loading files…</p> : galleryTagInput.trim() ? (
                <p>No files match this search. Change the tags or clear the search.</p>
              ) : (
                <p>No files yet. Add pictures and videos to your library folder, or connect your accounts to sync favorites from all your sites</p>
              )}
            </div>
          ) : (
            <>
              <VirtualGalleryMasonry
                files={galleryFiles}
                duplicateGroups={duplicateGroups ?? []}
                sourceSites={sourceSites}
                voteSystemEnabled={voteSystemEnabled}
                maxGridColumns={maxGridColumns}
                onUpvote={onUpvote}
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
