import { useState } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TagSearchInput } from '@/features/library/TagSearchInput';

/** Asks for the tags to add to or remove from the selected files; several are separated by spaces. */
export function TagPromptDialog({
  title,
  confirmLabel,
  onSubmit,
  onClose
}: {
  title: string;
  confirmLabel: string;
  onSubmit: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  const tags = value.split(/\s+/).filter(Boolean);
  const submit = () => {
    if (tags.length > 0) onSubmit(tags);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <TagSearchInput
          id="selection-tag-input"
          scope="library"
          value={value}
          onChange={setValue}
          onPick={setValue}
          onSubmit={submit}
          placeholder="tags, separated by spaces"
        />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-outline-light" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={tags.length === 0} onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
