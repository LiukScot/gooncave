import type { DuplicateFile, DuplicateGroup, DuplicateScanStatus, FileItem } from '@/api';

export type GalleryStack = {
  anchor: FileItem;
  members: Array<FileItem | DuplicateFile>;
};

/** Copies added since the last scan stay apart until a new one covers them. */
export const needsDuplicateRescan = (scan: Pick<DuplicateScanStatus, 'status' | 'stale'>): boolean =>
  scan.status !== 'running' && (scan.status !== 'done' || Boolean(scan.stale));

/** The first loaded copy anchors a group so later pages cannot move its tile. */
export function stackGalleryFiles(
  files: FileItem[],
  groups: DuplicateGroup[]
): GalleryStack[] {
  const groupByFile = new Map<string, DuplicateGroup>();
  for (const group of groups) {
    if (group.files.length < 2) continue;
    for (const member of group.files) groupByFile.set(member.id, group);
  }

  const seenGroups = new Set<DuplicateGroup>();
  const loadedById = new Map(files.map((file) => [file.id, file]));
  const stacks: GalleryStack[] = [];
  for (const file of files) {
    const group = groupByFile.get(file.id);
    if (!group) {
      stacks.push({ anchor: file, members: [file] });
      continue;
    }
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    const anchorSummary = group.files.find((member) => member.id === file.id);
    stacks.push({
      anchor: file,
      members: [
        { ...file, favoriteProviders: anchorSummary?.favoriteProviders ?? file.favoriteProviders },
        ...group.files
          .filter((member) => member.id !== file.id)
          .map((member) => ({ ...member, ...loadedById.get(member.id) }))
      ]
    });
  }
  return stacks;
}
