import type { DuplicateFile, DuplicateGroup, FileItem } from '@/api';

export type GalleryStack = {
  anchor: FileItem;
  members: Array<FileItem | DuplicateFile>;
};

/** Newest order can wait for the oldest copy, so the tile stays in place as pages load. */
export function stackGalleryFiles(
  files: FileItem[],
  groups: DuplicateGroup[],
  oldestPositionFolderId: string | null = null
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
    if (
      oldestPositionFolderId !== null &&
      group.files.every((member) => member.mtime)
    ) {
      const oldest = group.files
        .filter(
          (member) =>
            !oldestPositionFolderId || member.folderId === oldestPositionFolderId
        )
        .reduce<DuplicateGroup['files'][number] | null>(
          (current, member) =>
            !current || member.mtime! < current.mtime! ||
            (member.mtime === current.mtime && member.id < current.id)
              ? member
              : current,
          null
        );
      if (oldest && loadedById.has(oldest.id) && oldest.id !== file.id) continue;
    }
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
