import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, HardDrive, Share2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { OverlayButton } from './DetailSections';
import { ClosesPanel, MoreActionsPanel } from './MoreActionsPanel';

import { api } from '@/api';
import type { FileItem } from '@/api';
import { queryKeys } from '@/lib/query-keys';
import { useAppearanceStore } from '@/stores/appearanceStore';

/**
 * The actions on an open file: the one chosen in Settings → Appearance sits in
 * the corner, the others behind one button. Keeping it on
 * this device is left out when the device keeps every file, where it would
 * change nothing. Its icon says whether the file is kept; an original that is
 * here only for now keeps the cloud, because it can still leave. The hooks stay
 * outside the panel, so a download goes on being shown after the panel closes.
 */
export function FileMoreMenu({
  file,
  vote,
  onKept,
  deleting,
  deleteTitle,
  onDelete,
  onShare
}: {
  file: FileItem;
  vote?: ReactNode;
  onKept: (fileId: string, locationType: FileItem['locationType']) => void;
  deleting: boolean;
  deleteTitle: string;
  onDelete: () => void;
  onShare: () => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const quick = useAppearanceStore((state) => state.quickActions.file);
  const key = [...queryKeys.files.all, file.id, 'kept'] as const;
  const originals = useQuery({ queryKey: queryKeys.originals, queryFn: api.getOriginals });
  // While the setting is unknown the item waits; if it cannot be read, the item still works.
  const keepsEverything = originals.isError ? false : originals.data?.keepAll !== false;
  const kept = useQuery({ queryKey: key, queryFn: () => api.getKept(file.id), enabled: !keepsEverything });
  const update = useMutation({
    mutationFn: (value: boolean) => api.setKept(file.id, value),
    onSuccess: ({ kept: value, locationType }) => {
      client.setQueryData(key, value);
      onKept(file.id, locationType);
      toast.success(
        value
          ? 'Downloaded and kept on this device'
          : locationType === 'REMOTE'
            ? 'No longer kept: removed from this device'
            : 'No longer kept: it can be removed from this device to free space'
      );
    },
    onError: (error) => toast.error(`The file could not be kept on this device: ${error.message}`),
    // The message would appear behind the panel.
    onSettled: () => setOpen(false)
  });

  const on = kept.data === true;
  const here = file.locationType === 'LOCAL';
  const KeepIcon = on ? HardDrive : CloudDownload;
  const keepLabel = update.isPending
    ? update.variables ? 'Downloading to this device…' : 'Updating this device…'
    : on ? 'Remove from device' : 'Keep on device';

  const keepTitle = on || !here ? undefined : 'On this device for now, removed when space is freed';
  const shareTitle = 'Sources: share or open the posts this file was found at';

  return (
    <>
      {quick === 'vote' ? vote : null}
      {quick === 'delete' ? (
        <OverlayButton
          icon={Trash2}
          label={deleting ? 'Deleting file…' : 'Delete file'}
          title={deleteTitle}
          disabled={deleting}
          busy={deleting}
          onClick={onDelete}
        />
      ) : null}
      {quick === 'keep' && !keepsEverything ? (
        <OverlayButton
          icon={KeepIcon}
          label={keepLabel}
          title={keepTitle}
          disabled={kept.isPending || update.isPending}
          busy={update.isPending}
          onClick={() => update.mutate(!on)}
        />
      ) : null}
      {quick === 'share' ? (
        <OverlayButton icon={Share2} label="Share" title={shareTitle} onClick={onShare} />
      ) : null}
      <MoreActionsPanel open={open} setOpen={setOpen} title="Actions for this file" busy={update.isPending}>
        {quick === 'vote' || !vote ? null : <ClosesPanel close={() => setOpen(false)}>{vote}</ClosesPanel>}
        {quick === 'delete' ? null : (
          <button
            type="button"
            className="btn btn-outline-light panel-pill"
            disabled={deleting}
            title={deleteTitle}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 aria-hidden="true" />
            {deleting ? 'Deleting file…' : 'Delete file'}
          </button>
        )}
        {keepsEverything || quick === 'keep' ? null : (
          <button
            type="button"
            className="btn btn-outline-light panel-pill"
            disabled={kept.isPending || update.isPending}
            title={keepTitle}
            // Stays open until the answer: the label is what shows the download going on.
            onClick={() => update.mutate(!on)}
          >
            <KeepIcon aria-hidden="true" />
            {keepLabel}
          </button>
        )}
        {quick === 'share' ? null : (
          <button
            type="button"
            className="btn btn-outline-light panel-pill"
            title={shareTitle}
            onClick={() => {
              setOpen(false);
              onShare();
            }}
          >
            <Share2 aria-hidden="true" />
            Share
          </button>
        )}
      </MoreActionsPanel>
    </>
  );
}
