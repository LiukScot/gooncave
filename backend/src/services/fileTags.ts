import { filesRepo } from '../db/repos/filesRepo';
import { tagDbRepo } from '../db/repos/tagDbRepo';
import type { FileTagRecord } from '../db/types';

export type FileTagsView = {
  /** Tags a provider or the user actually put on the file, minus removals. */
  tags: FileTagRecord[];
  /**
   * Tags every asserted tag implies, e.g. `canine` for a file tagged
   * `husky`. Derived on read rather than stored: they are a property of the
   * implication table, and writing them would duplicate it once per file.
   */
  implied: string[];
};

export const describeFileTags = async (
  fileId: string
): Promise<FileTagsView> => {
  const stored = await filesRepo.listTagsForFile(fileId);
  const suppressed = new Set(tagDbRepo.listSuppressedTags(fileId));
  const tags = stored.filter((tag) => !suppressed.has(tag.tag));

  const asserted = new Set(tags.map((tag) => tag.canonicalTag));
  const implied = tagDbRepo
    .implicationsFor([...asserted])
    // A tag that is also asserted is not "implied" from the reader's point
    // of view — it is already in the list above.
    .filter((tag) => !asserted.has(tag))
    .sort();

  return { tags, implied };
};

/**
 * Takes a tag off one file, by the canonical name its pill displayed rather
 * than the originals behind it — a merged pill stands for several stored
 * tags and has to remove all of them.
 *
 * Provider tags are suppressed, so the refresh button can bring them back.
 * A manual tag is deleted outright: nothing would re-fetch it, so leaving a
 * suppression behind would resurrect a tag the user typed and then removed
 * the next time they hit refresh.
 */
export const removeTagsForFile = async (
  fileId: string,
  canonicalTags: string[]
): Promise<void> => {
  const wanted = new Set(canonicalTags);
  const stored = await filesRepo.listTagsForFile(fileId);
  const matching = stored.filter((tag) => wanted.has(tag.canonicalTag));

  for (const tag of matching.filter((tag) => tag.source === 'MANUAL')) {
    await filesRepo.removeManualTag(fileId, tag.tag);
  }
  tagDbRepo.suppressTags(
    fileId,
    matching.filter((tag) => tag.source !== 'MANUAL').map((tag) => tag.tag)
  );
};
