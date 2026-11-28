import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FolderOpen, ImagePlus, RefreshCw, Star, Tag, Tags as TagsIcon, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { tagFilters } from './tagInputTokens';
import { TagSearchInput } from './TagSearchInput';
import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { BooruSite, DuplicateGroup, FileItem } from '@/api';
import { api } from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import { WavyProgress } from '@/components/WavyProgress';
import { runBulk } from '@/features/selection/runBulk';
import { SelectionBar, type SelectionAction } from '@/features/selection/SelectionBar';
import { TagPromptDialog } from '@/features/selection/TagPromptDialog';
import { useGridSelection } from '@/features/selection/useGridSelection';
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
import { queryKeys } from '@/lib/query-keys';
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
  /** Gates the "Most stars" sort and the per-card star chip. */
  starsEnabled: boolean;
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
  onGiveStar: (fileId: string) => Promise<void>;
  /** Gives a star like `onGiveStar`, but throws on failure so a bulk action can count it. */
  onStarFile: (fileId: string) => Promise<void>;
  onFileDeleted: (fileId: string) => void;
  onLoadMore: () => void;
}

type GalleryMedia = 'all' | 'photos' | 'videos' | 'none';

const SORT_LABELS: Record<GallerySort, string> = {
  rated: 'Most stars',
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
  starsEnabled,
  maxGridColumns,
  galleryFilters,
  galleryTagInput,
  galleryLoadMoreRef,
  onTagInputChange,
  onTagSearchNow,
  onFilterChange,
  onSortChange,
  onFileOpen,
  onGiveStar,
  onStarFile,
  onFileDeleted,
  onLoadMore
}: GalleryViewProps) {
  const selection = useGridSelection();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [tagPrompt, setTagPrompt] = useState<'add' | 'remove' | null>(null);
  const selectedIds = galleryFiles.map((file) => file.id).filter((id) => selection.selected.has(id));
  const { active: selecting, exit: exitSelection } = selection;
  // A new search can hide every selected file; taps would keep selecting with no bar to say so.
  useEffect(() => {
    if (selecting && selectedIds.length === 0) exitSelection();
  }, [selecting, selectedIds.length, exitSelection]);
  const tagsChanged = () => void queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
  const applyTags = async (mode: 'add' | 'remove', tags: string[]) => {
    setTagPrompt(null);
    await runBulk(mode === 'add' ? 'Tagged' : 'Untagged', selectedIds, async (id) => {
      if (mode === 'add') {
        for (const tag of tags) await api.addManualTag(id, tag, 'general');
      } else {
        await api.suppressFileTags(id, tags);
      }
    }, tagsChanged);
    selection.exit();
  };
  const selectionActions: SelectionAction[] = [
    ...(starsEnabled
      ? [{
          key: 'star',
          label: 'Give a star',
          icon: Star,
          run: () => runBulk('Starred', selectedIds, onStarFile)
        }]
      : []),
    {
      key: 'add-tag',
      label: 'Add tag',
      icon: Tag,
      run: async () => {
        setTagPrompt('add');
        return 'keep' as const;
      }
    },
    {
      key: 'remove-tag',
      label: 'Remove tag',
      icon: TagsIcon,
      run: async () => {
        setTagPrompt('remove');
        return 'keep' as const;
      }
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: Trash2,
      danger: true,
      run: async () => {
        const count = selectedIds.length;
        const sure = await confirm(
          `Delete ${count} ${count === 1 ? 'file' : 'files'} from every device? Posts they came from may also leave your favorites on sites that sync deletions.`,
          { title: 'Delete files', confirmLabel: 'Delete', destructive: true }
        );
        if (!sure) return 'keep';
        await runBulk('Deleted', selectedIds, async (id) => {
          const result = await api.deleteFile(id);
          if (result.errors?.length) throw new Error(result.errors.join('; '));
          onFileDeleted(id);
        }, () => void queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.all }));
      }
    }
  ];
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
                placeholder="tags · ~either · -not · stars:>5"
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
                  .filter((sort) => sort !== 'rated' || starsEnabled)
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
              ) : galleryPageState.loading ? (
                <div className="flex flex-col items-center gap-4" role="status">
                  <WavyProgress label="Loading files" />
                  Loading files…
                </div>
              ) : !online && narrowed.length === 0 ? (
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
                selected={selection.selected}
                gridProps={selection.gridProps}
                files={galleryFiles}
                duplicateGroups={duplicateGroups ?? undefined}
                sourceSites={sourceSites}
                starsEnabled={starsEnabled}
                maxGridColumns={maxGridColumns}
                openFileId={openFileId}
                location={galleryLocation}
                filesLocation={galleryFilesLocation}
                hasMore={galleryHasMore}
                onLoadMore={onLoadMore}
                onGiveStar={onGiveStar}
                onFileOpen={onFileOpen}
              />
              {galleryHasMore ? (
                <div className="flex justify-center mt-4">
                  {galleryPageState.loading ? (
                    <WavyProgress label="Loading more files" />
                  ) : (
                    <button className="btn btn-outline-light btn-sm" onClick={onLoadMore}>
                      Load more
                    </button>
                  )}
                </div>
              ) : null}
              <div ref={galleryLoadMoreRef} className="gallery-load-sentinel" />
              {selection.active && !openFileId ? (
                <SelectionBar
                  count={selectedIds.length}
                  actions={selectionActions}
                  onSelectAll={() => selection.selectAll(galleryFiles.map((file) => file.id))}
                  onCancel={selection.exit}
                />
              ) : null}
              {tagPrompt ? (
                <TagPromptDialog
                  title={tagPrompt === 'add' ? `Add tags to ${selectedIds.length} files` : `Remove tags from ${selectedIds.length} files`}
                  confirmLabel={tagPrompt === 'add' ? 'Add' : 'Remove'}
                  onSubmit={(tags) => void applyTags(tagPrompt, tags)}
                  onClose={() => setTagPrompt(null)}
                />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
