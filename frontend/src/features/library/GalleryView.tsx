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
  PanelMultiChoice,
  PanelSection,
  SearchPanel,
  type ActiveFilter,
  type FilterChip
} from '@/features/shell/SearchPanel';
import { useOnline } from '@/lib/online';
import { useErrorToast } from '@/lib/useErrorToast';
import { useAppearanceStore } from '@/stores/appearanceStore';


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
  /** Adds files the person picks to the library; with it a small "Add files" button floats beside the lens. */
  onAddFiles?: (files: File[]) => void;
  /** Picks from the photo library instead, where the originals can be deleted after adding. */
  onAddFromPhotos?: () => void;
  /** The library folder, set where the app can show it in the file manager. */
  openFolderRoot?: string;
  galleryFiles: FileItem[];
  duplicateGroups: DuplicateGroup[] | null;
  duplicateScanError: string | null;
  sourceSites: BooruSite[];
  galleryHasMore: boolean;
  /** The file open over the list, if any. */
  openFileId?: string | null;
  /** The list asked for: all files, or only the ones on this device. */
  galleryLocation?: string;
  /** The list `galleryFiles` holds, which stays the old one until the new one arrives. */
  galleryFilesLocation?: string;
  galleryPageState: FetchState;
  gallerySort: GallerySort;
  /** Gates the "Rated" sort and the per-card score chip. */
  voteSystemEnabled: boolean;
  maxGridColumns: number;
  galleryFilters: { photos: boolean; videos: boolean; downloaded: boolean };
  galleryTagInput: string;

  // --- refs ---
  galleryLoadMoreRef: React.RefObject<HTMLDivElement | null>;

  // --- callbacks ---
  onTagInputChange: (value: string) => void;
  onTagSearchNow: (value: string) => void;
  onFilterChange: (
    patch: Partial<{ photos: boolean; videos: boolean; downloaded: boolean }>
  ) => void;
  onSortChange: (sort: GallerySort) => void;
  onFileOpen: (file: FileItem) => void;
  onUpvote: (fileId: string) => Promise<void>;
  onLoadMore: () => void;
}

type GalleryMedia = 'all' | 'photos' | 'videos' | 'none';

const SORT_LABELS: Record<GallerySort, string> = {
  rated: 'Rated',
  mtime_desc: 'Newest',
  mtime_asc: 'Oldest',
  random: 'Random'
};

const DEFAULT_SORT: GallerySort = 'mtime_desc';

export function GalleryView({
  libraryAvailable = true,
  favoritesSync,
  onAddFiles,
  onAddFromPhotos,
  openFolderRoot,
  galleryFiles,
  duplicateGroups,
  duplicateScanError,
  sourceSites,
  galleryHasMore,
  openFileId,
  galleryLocation,
  galleryFilesLocation,
  galleryPageState,
  gallerySort,
  voteSystemEnabled,
  maxGridColumns,
  galleryFilters,
  galleryTagInput,
  galleryLoadMoreRef,
  onTagInputChange,
  onTagSearchNow,
  onFilterChange,
  onSortChange,
  onFileOpen,
  onUpvote,
  onLoadMore
}: GalleryViewProps) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const pickFiles = () => (onAddFromPhotos ? onAddFromPhotos() : pickerRef.current?.click());
  const quick = useAppearanceStore((state) => state.quickActions.gallery);
  const online = useOnline();
  const navigate = useNavigate();
  useErrorToast(favoritesSync?.error && `Favorites sync: ${favoritesSync.error}`, {
    action: {
      label: 'Open Accounts',
      onClick: () => void navigate({ to: '/app/settings/accounts' })
    }
  }, { onlyOnline: true });
  useErrorToast(galleryPageState.error && `Gallery: ${galleryPageState.error}`);
  useErrorToast(
    duplicateScanError && `Duplicate stacks unavailable: ${duplicateScanError}`
  );

  const clearSearch = () => onTagSearchNow('');
  const media: GalleryMedia =
    galleryFilters.photos && galleryFilters.videos
      ? 'all'
      : galleryFilters.photos
        ? 'photos'
        : galleryFilters.videos
          ? 'videos'
          : 'none';
  const showAllMedia = () => onFilterChange({ photos: true, videos: true });
  const query = galleryTagInput.trim();
  const narrowed: ActiveFilter[] = [
    ...tagFilters(query, onTagSearchNow),
    ...(media === 'all'
      ? []
      : [{
          key: 'media',
          label: media === 'photos' ? 'Photos only' : media === 'videos' ? 'Videos only' : 'No photos or videos',
          clear: showAllMedia
        }]),
    ...(galleryFilters.downloaded && online
      ? [{
          key: 'downloaded',
          label: 'Downloaded only',
          clear: () => onFilterChange({ downloaded: false })
        }]
      : [])
  ];
  const filters: FilterChip[] = [
    ...narrowed,
    // Offline it cannot be turned off, so its chip has nothing to undo.
    ...(online ? [] : [{ key: 'downloaded', label: 'Downloaded only' }]),
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
              (favoritesSync && quick !== 'sync') || (onAddFiles && quick !== 'add') || openFolderRoot
                ? (close) => (
                    <div className="panel-pills">
                      {favoritesSync && quick !== 'sync' ? (
                        <button
                          className="btn btn-outline-light panel-pill"
                          type="button"
                          onClick={favoritesSync.onSync}
                          disabled={favoritesSync.running || !online}
                          aria-busy={favoritesSync.running && online}
                          aria-label={online ? undefined : 'Offline: syncing favorites needs a connection'}
                        >
                          <RefreshCw
                            className={favoritesSync.running && online ? 'animate-spin motion-reduce:animate-none' : undefined}
                            aria-hidden="true"
                          />
                          {!online ? 'Offline' : favoritesSync.running ? 'Syncing favorites…' : 'Sync favorites'}
                        </button>
                      ) : null}
                      {onAddFiles && quick !== 'add' ? (
                        <button
                          className="btn btn-outline-light panel-pill"
                          type="button"
                          onClick={() => {
                            close();
                            pickFiles();
                          }}
                        >
                          <ImagePlus aria-hidden="true" />
                          Add files
                        </button>
                      ) : null}
                      {openFolderRoot ? (
                        // The desktop window opens this link in the file manager (desktop/electron/links.js).
                        <a
                          className="btn btn-outline-light panel-pill"
                          href={`/open-folder?path=${encodeURIComponent(openFolderRoot)}`}
                        >
                          <FolderOpen aria-hidden="true" />
                          Open folder
                        </a>
                      ) : null}
                    </div>
                  )
                : undefined
            }
            floatingActions={
              onAddFiles && quick === 'add' ? (
                <button
                  className="search-lens-action"
                  type="button"
                  aria-label="Add files"
                  title="Add files"
                  onClick={pickFiles}
                >
                  <ImagePlus aria-hidden="true" />
                </button>
              ) : favoritesSync && quick === 'sync' ? (
                <button
                  className="search-lens-action"
                  type="button"
                  aria-label={
                    !online
                      ? 'Offline: syncing favorites needs a connection'
                      : favoritesSync.running ? 'Syncing favorites…' : 'Sync favorites'
                  }
                  title={online ? 'Sync favorites' : 'Offline: syncing favorites needs a connection'}
                  onClick={favoritesSync.onSync}
                  disabled={favoritesSync.running || !online}
                  aria-busy={favoritesSync.running && online}
                >
                  <RefreshCw
                    className={favoritesSync.running && online ? 'animate-spin motion-reduce:animate-none' : undefined}
                    aria-hidden="true"
                  />
                </button>
              ) : undefined
            }
            filters={filters}
            search={
              <TagSearchInput
                value={galleryTagInput}
                onChange={onTagInputChange}
                onClear={clearSearch}
                onPick={onTagSearchNow}
                onSubmit={() => onTagSearchNow(galleryTagInput)}
                placeholder="tags · ~either · -not · score:>5"
              />
            }
          >
            <PanelSection label="Show">
              <PanelMultiChoice
                label="Show"
                options={[
                  {
                    label: 'Photos',
                    pressed: galleryFilters.photos,
                    onToggle: () => onFilterChange({ photos: !galleryFilters.photos })
                  },
                  {
                    label: 'Videos',
                    pressed: galleryFilters.videos,
                    onToggle: () => onFilterChange({ videos: !galleryFilters.videos })
                  },
                  {
                    label: 'Downloaded',
                    pressed: galleryFilters.downloaded || !online,
                    disabled: !online,
                    onToggle: () => onFilterChange({ downloaded: !galleryFilters.downloaded })
                  }
                ]}
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

          {onAddFiles ? (
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
          ) : null}

          {galleryFiles.length === 0 && !libraryAvailable ? (
            <FeatureUnavailable feature="Folder import" />
          ) : galleryFiles.length === 0 ? (
            <div className="gallery-empty text-muted-foreground">
              {media === 'none' ? (
                <>
                  <p>Nothing to show: Photos and Videos are both off.</p>
                  <button className="btn btn-outline-light btn-sm mt-2" type="button" onClick={showAllMedia}>
                    Show photos and videos
                  </button>
                </>
              ) : galleryPageState.loading ? <p>Loading files…</p> : !online && narrowed.length === 0 ? (
                <p>No signal in the cave, and nothing downloaded to keep you company. Everything else comes back when you reconnect.</p>
              ) : narrowed.length > 0 ? (
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
                duplicateGroups={duplicateGroups ?? undefined}
                sourceSites={sourceSites}
                voteSystemEnabled={voteSystemEnabled}
                maxGridColumns={maxGridColumns}
                openFileId={openFileId}
                location={galleryLocation}
                filesLocation={galleryFilesLocation}
                hasMore={galleryHasMore}
                onLoadMore={onLoadMore}
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
