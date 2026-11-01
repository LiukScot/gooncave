import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, ImagePlus, RefreshCw } from 'lucide-react';
import { useRef } from 'react';

import { tagFilters } from './tagInputTokens';
import { TagSearchInput } from './TagSearchInput';
import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { BooruSite, DuplicateGroup, FileItem } from '@/api';
import { FeatureUnavailable } from '@/features/shell/FeatureUnavailable';
import {
  PanelChoice,
  PanelSection,
  SearchPanel,
  type ActiveFilter,
  type FilterChip
} from '@/features/shell/SearchPanel';
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
  galleryTagInput: string;

  // --- refs ---
  galleryLoadMoreRef: React.RefObject<HTMLDivElement | null>;

  // --- callbacks ---
  onTagInputChange: (value: string) => void;
  onTagQueryClear: () => void;
  onFilterChange: (
    patch: Partial<{ photos: boolean; videos: boolean }>
  ) => void;
  onSortChange: (sort: GallerySort) => void;
  onFileOpen: (file: FileItem) => void;
  onUpvote: (fileId: string) => Promise<void>;
  onLoadMore: () => void;
}

type GalleryMedia = 'all' | 'photos' | 'videos';

const MEDIA_OPTIONS: { value: GalleryMedia; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'photos', label: 'Photos' },
  { value: 'videos', label: 'Videos' }
];

const SORT_LABELS: Record<GallerySort, string> = {
  rated: 'Rated',
  mtime_desc: 'Newest',
  mtime_asc: 'Oldest',
  random: 'Random'
};

const DEFAULT_SORT: GallerySort = 'mtime_desc';

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
  galleryTagInput,
  galleryLoadMoreRef,
  onTagInputChange,
  onTagQueryClear,
  onFilterChange,
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

  const clearSearch = () => {
    onTagInputChange('');
    onTagQueryClear();
  };
  const media: GalleryMedia =
    galleryFilters.photos === galleryFilters.videos
      ? 'all'
      : galleryFilters.photos
        ? 'photos'
        : 'videos';
  const showAllMedia = () => onFilterChange({ photos: false, videos: false });
  const query = galleryTagInput.trim();
  const narrowed: ActiveFilter[] = [
    ...tagFilters(query, (next) => (next ? onTagInputChange(next) : clearSearch())),
    ...(media === 'all'
      ? []
      : [{
          key: 'media',
          label: media === 'photos' ? 'Photos only' : 'Videos only',
          clear: showAllMedia
        }])
  ];
  const filters: FilterChip[] = [
    ...narrowed,
    {
      key: 'order',
      label: `Order: ${SORT_LABELS[gallerySort]}`,
      clear: gallerySort === DEFAULT_SORT ? undefined : () => onSortChange(DEFAULT_SORT)
    }
  ];

  return (
    <div className="col-12">
      <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
        <div className="card-body">
          <SearchPanel
            title="Search and filter the gallery"
            actions={
              favoritesSync || openFolderRoot || onAddFiles ? (
                <div className="panel-pills">
                  {favoritesSync ? (
                    <button
                      className="btn btn-outline-light panel-pill"
                      type="button"
                      onClick={favoritesSync.onSync}
                      disabled={favoritesSync.running}
                      aria-busy={favoritesSync.running}
                    >
                      <RefreshCw
                        className={favoritesSync.running ? 'animate-spin motion-reduce:animate-none' : undefined}
                        aria-hidden="true"
                      />
                      {favoritesSync.running ? 'Syncing favorites…' : 'Sync favorites'}
                    </button>
                  ) : null}
                  {openFolderRoot ? (
                    <a
                      className="btn btn-outline-light panel-pill"
                      href={folderUrl(openFolderRoot)}
                    >
                      <FolderOpen aria-hidden="true" />
                      Open folder
                    </a>
                  ) : null}
                  {onAddFiles ? (
                    <>
                      <button
                        className="btn btn-outline-light panel-pill"
                        type="button"
                        onClick={() => (onAddFromPhotos ? onAddFromPhotos() : pickerRef.current?.click())}
                      >
                        <ImagePlus aria-hidden="true" />
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
                </div>
              ) : null
            }
            filters={filters}
            search={
              <TagSearchInput
                value={galleryTagInput}
                onChange={onTagInputChange}
                onClear={clearSearch}
                placeholder="tags · ~either · -not · score:>5"
              />
            }
          >
            <PanelSection label="Show">
              <PanelChoice
                label="Show"
                value={media}
                options={MEDIA_OPTIONS}
                onChange={(next) =>
                  onFilterChange({
                    photos: next === 'photos',
                    videos: next === 'videos'
                  })
                }
              />
            </PanelSection>
            <PanelSection label="Order by">
              <PanelChoice
                label="Order by"
                value={gallerySort}
                options={(Object.keys(SORT_LABELS) as GallerySort[])
                  .filter((sort) => sort !== 'rated' || voteSystemEnabled)
                  .map((sort) => ({ value: sort, label: SORT_LABELS[sort] }))}
                onChange={onSortChange}
              />
            </PanelSection>
          </SearchPanel>

          {galleryFiles.length === 0 && !libraryAvailable ? (
            <FeatureUnavailable feature="Folder import" />
          ) : galleryFiles.length === 0 ? (
            <div className="gallery-empty text-muted-foreground">
              {galleryPageState.loading ? <p>Loading files…</p> : narrowed.length > 0 ? (
                <>
                  <p>No files match these filters.</p>
                  <button
                    className="btn btn-outline-light btn-sm mt-2"
                    type="button"
                    onClick={() => narrowed.forEach((filter) => filter.clear())}
                  >
                    Clear filters
                  </button>
                </>
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
