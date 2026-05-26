import React from 'react';
import type { Folder } from '@/api';

type FetchState = { loading: boolean; error: string | null };

type FolderUploadPhase = 'uploading' | 'processing' | 'success' | 'warning' | 'error';

type FolderUploadState = {
  phase: FolderUploadPhase;
  progress: number;
  message: string;
  detail: string | null;
};

export type FolderDescriptor = {
  isRoot: boolean;
  isAutoManaged: boolean;
  title: string;
  subtitle: string | null;
  pathLabel: string;
  filterLabel: string;
};

export interface FoldersListPanelProps {
  orderedFolders: Folder[];
  folderDetailsById: Map<string, FolderDescriptor>;
  folderUploads: Record<string, FolderUploadState>;
  folderActionState: FetchState;
  favoritesSettings: { favoritesRootId: string | null };
  favoritesSettingsState: FetchState;
  libraryRoot: string;
  uploadInputAccept: string;
  uploadInputRef: React.RefObject<HTMLInputElement | null>;
  onFolderUploadInputChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onOpenFolderUploadPicker: (folderId: string) => void;
  onUpdateFavoritesRoot: (folderId: string) => void;
  onDeleteFolder: (folder: Folder) => void;
  describeFolder: (folder: Folder, libraryRoot: string) => FolderDescriptor;
}

const folderUploadBarClass = (phase: FolderUploadPhase): string => {
  switch (phase) {
    case 'uploading':
      return 'bg-info';
    case 'processing':
      return 'bg-warning text-dark progress-bar-striped progress-bar-animated';
    case 'success':
      return 'bg-success';
    case 'warning':
      return 'bg-warning text-dark';
    case 'error':
      return 'bg-danger';
    default:
      return 'bg-secondary';
  }
};

export function FoldersListPanel({
  orderedFolders,
  folderDetailsById,
  folderUploads,
  folderActionState,
  favoritesSettings,
  favoritesSettingsState,
  libraryRoot,
  uploadInputAccept,
  uploadInputRef,
  onFolderUploadInputChange,
  onOpenFolderUploadPicker,
  onUpdateFavoritesRoot,
  onDeleteFolder,
  describeFolder,
}: FoldersListPanelProps) {
  return (
    <div className="col-12 settings-section">
      <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
        <div className="card-body">
          <div className="flex justify-between items-center mb-4">
            <h2 className="h5 mb-0">Library folders</h2>
          </div>
          <input
            ref={uploadInputRef}
            type="file"
            className="hidden"
            multiple
            accept={uploadInputAccept}
            onChange={onFolderUploadInputChange}
          />
          <div className="text-muted-foreground text-sm mb-4">
            Your main library appears below automatically. Mounted folders also appear automatically when they
            are direct children of your library root. Check the README for setup instructions.
          </div>
          {folderActionState.error ? (
            <div className="text-destructive text-sm mb-4">Folder error: {folderActionState.error}</div>
          ) : null}
          {orderedFolders.length === 0 ? (
            <p className="text-muted-foreground">No folders configured.</p>
          ) : (
            <div className="list-group folder-list">
              {orderedFolders.map((folder) => {
                const isFavoritesRoot = favoritesSettings.favoritesRootId === folder.id;
                const folderInfo = folderDetailsById.get(folder.id) ?? describeFolder(folder, libraryRoot);
                const uploadState = folderUploads[folder.id];
                const uploadBusy = uploadState?.phase === 'uploading' || uploadState?.phase === 'processing';
                return (
                  <div
                    key={folder.id}
                    className={`list-group-item flex justify-between items-center bg-secondary text-foreground border border-secondary folder-card${folderInfo.isRoot ? ' folder-card-root' : ''}${uploadBusy ? ' folder-card-uploading' : ''}`}
                  >
                    <div className="folder-card-body">
                      <div className="folder-card-header">
                        <div className="folder-card-heading">
                          <div className="font-semibold folder-card-title">{folderInfo.title}</div>
                          {folderInfo.subtitle ? <div className="text-muted-foreground text-sm">{folderInfo.subtitle}</div> : null}
                        </div>
                        <div className="flex gap-2 folder-card-actions">
                          <button
                            className="btn btn-outline-light btn-sm"
                            onClick={() => { onOpenFolderUploadPicker(folder.id); }}
                            disabled={uploadBusy || folderActionState.loading}
                            title="Upload files into this folder"
                          >
                            {uploadState?.phase === 'processing' ? 'Processing…' : uploadState?.phase === 'uploading' ? 'Uploading…' : 'Upload files'}
                          </button>
                          <button
                            className={`btn btn-outline-warning btn-sm${isFavoritesRoot ? ' active' : ''}`}
                            onClick={() => { onUpdateFavoritesRoot(folder.id); }}
                            disabled={favoritesSettingsState.loading || uploadBusy}
                            title="Use this folder for favorites sync"
                          >
                            {isFavoritesRoot ? 'Favorites sync' : 'Use for favorites'}
                          </button>
                          {folderInfo.isRoot || folderInfo.isAutoManaged ? null : (
                            <button
                              className="btn btn-sm btn-outline-danger"
                              onClick={() => { void onDeleteFolder(folder); }}
                              disabled={folderActionState.loading || folder.status === 'SCANNING' || uploadBusy}
                              title="Remove this folder"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="folder-card-meta">
                        <div className="folder-card-pathline">
                          <span className="folder-card-meta-label">Path</span>
                          <span className="text-muted-foreground text-sm folder-card-path" title={folder.path}>{folder.path}</span>
                        </div>
                      </div>
                      {uploadState ? (
                        <div className="folder-upload-state mt-4">
                          <div className="progress folder-upload-progress" role="progressbar" aria-valuenow={uploadState.progress} aria-valuemin={0} aria-valuemax={100}>
                            <div
                              className={`progress-bar ${folderUploadBarClass(uploadState.phase)}`}
                              style={{ width: `${Math.max(uploadState.progress, uploadState.phase === 'processing' ? 100 : 0)}%` }}
                            >
                              {uploadState.progress}%
                            </div>
                          </div>
                          <div className="text-sm mt-2 folder-upload-message">{uploadState.message}</div>
                          {uploadState.detail ? (
                            <div className="text-sm text-muted-foreground mt-1 folder-upload-detail">{uploadState.detail}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
