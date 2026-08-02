import type { FileItem, Folder } from '@/api';
import { API_BASE } from '@/api';

const THUMB_SIZE = 220;

export type FetchState = { loading: boolean; error: string | null };
export type GallerySort = 'manual' | 'mtime_desc' | 'mtime_asc' | 'random';

/** Minimal shape of folderDetailsById values used in this view */
export type FolderDetail = { filterLabel?: string };

export interface GalleryViewProps {
  // --- state ---
  galleryFolderId: string;
  galleryFiles: FileItem[];
  galleryHasMore: boolean;
  galleryPageState: FetchState;
  gallerySort: GallerySort;
  galleryFilters: { photos: boolean; videos: boolean; starred: boolean };
  isGalleryFilterOpen: boolean;
  galleryTagInput: string;
  galleryFilterLabel: string;
  galleryCountText: string;
  selectedGalleryFolder: Folder | null;
  orderedFolders: Folder[];
  folderDetailsById: Map<string, FolderDetail>;
  draggingId: string | null;
  dragOverId: string | null;

  // --- refs ---
  galleryFilterRef: React.RefObject<HTMLDivElement | null>;
  galleryLoadMoreRef: React.RefObject<HTMLDivElement | null>;
  dragActiveRef: React.RefObject<boolean>;

  // --- callbacks ---
  onFolderChange: (folderId: string) => void;
  onTagInputChange: (value: string) => void;
  onTagQueryClear: () => void;
  onFilterChange: (
    patch: Partial<{ photos: boolean; videos: boolean; starred: boolean }>
  ) => void;
  onFilterClose: () => void;
  onFilterOpenToggle: () => void;
  onSortChange: (sort: GallerySort) => void;
  onFileOpen: (file: FileItem) => void;
  onLoadMore: () => void;
  /** Move an item in manual order: sourceId drops onto targetId */
  onMoveManualItem: (sourceId: string, targetId: string) => void;
  onDraggingChange: (id: string | null) => void;
  onDragOverChange: (id: string | null) => void;
}

export function GalleryView({
  galleryFolderId,
  galleryFiles,
  galleryHasMore,
  galleryPageState,
  gallerySort,
  galleryFilters,
  isGalleryFilterOpen,
  galleryTagInput,
  galleryFilterLabel,
  galleryCountText,
  selectedGalleryFolder,
  orderedFolders,
  folderDetailsById,
  draggingId,
  dragOverId,
  galleryFilterRef,
  galleryLoadMoreRef,
  dragActiveRef,
  onFolderChange,
  onTagInputChange,
  onTagQueryClear,
  onFilterChange,
  onFilterClose,
  onFilterOpenToggle,
  onSortChange,
  onFileOpen,
  onLoadMore,
  onMoveManualItem,
  onDraggingChange,
  onDragOverChange
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
                <button
                  className={`btn btn-${gallerySort === 'manual' ? 'primary' : 'outline-light'}`}
                  onClick={() => onSortChange('manual')}
                >
                  Manual
                </button>
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
                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="gallery-filter-videos"
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
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="gallery-filter-starred"
                      checked={galleryFilters.starred}
                      onChange={() =>
                        onFilterChange({ starred: !galleryFilters.starred })
                      }
                    />
                    <label
                      className="form-check-label"
                      htmlFor="gallery-filter-starred"
                    >
                      Starred
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
                {galleryFiles.map((file) => (
                  <div key={file.id} className="min-w-0">
                    <button
                      type="button"
                      className={`gallery-card h-full${gallerySort === 'manual' ? ' gallery-item-manual' : ''}${
                        draggingId === file.id ? ' gallery-item-dragging' : ''
                      }${dragOverId === file.id && draggingId !== file.id ? ' gallery-item-drop-target' : ''} border-0 bg-transparent p-0 text-left w-full`}
                      data-test-id="file-card"
                      aria-label={`Open ${file.path}`}
                      draggable={gallerySort === 'manual'}
                      onDragStart={(event) => {
                        if (gallerySort !== 'manual') return;
                        dragActiveRef.current = true;
                        onDraggingChange(file.id);
                        event.dataTransfer.effectAllowed = 'move';
                        try {
                          event.dataTransfer.setData('text/plain', file.id);
                        } catch {
                          // no-op
                        }
                      }}
                      onDragEnd={() => {
                        dragActiveRef.current = true;
                        window.setTimeout(() => {
                          dragActiveRef.current = false;
                        }, 0);
                        onDraggingChange(null);
                        onDragOverChange(null);
                      }}
                      onDragOver={(event) => {
                        if (gallerySort !== 'manual') return;
                        event.preventDefault();
                        if (dragOverId !== file.id) onDragOverChange(file.id);
                      }}
                      onDrop={(event) => {
                        if (gallerySort !== 'manual') return;
                        event.preventDefault();
                        const sourceId =
                          draggingId ??
                          event.dataTransfer.getData('text/plain');
                        if (sourceId) {
                          onMoveManualItem(sourceId, file.id);
                        }
                        dragActiveRef.current = true;
                        window.setTimeout(() => {
                          dragActiveRef.current = false;
                        }, 0);
                        onDraggingChange(null);
                        onDragOverChange(null);
                      }}
                      onClick={() => {
                        if (dragActiveRef.current) return;
                        onFileOpen(file);
                      }}
                    >
                      {file.thumbUrl ? (
                        <img
                          src={`${API_BASE}${file.thumbUrl}`}
                          alt={file.path}
                          width={THUMB_SIZE}
                          height={THUMB_SIZE}
                          className="img-fluid mb-2 rounded"
                          style={{
                            maxHeight: THUMB_SIZE,
                            objectFit: 'contain',
                            width: '100%'
                          }}
                          loading="lazy"
                          decoding="async"
                          fetchPriority="low"
                        />
                      ) : (
                        <div
                          className="mb-2 rounded flex items-center justify-center bg-background"
                          style={{ height: THUMB_SIZE }}
                        >
                          <span className="text-muted-foreground text-sm">
                            {file.mediaType.toLowerCase()}
                          </span>
                        </div>
                      )}
                      <div className="text-muted-foreground text-sm">
                        {file.durationMs
                          ? `${(file.durationMs / 1000).toFixed(1)}s`
                          : ''}
                      </div>
                    </button>
                  </div>
                ))}
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
