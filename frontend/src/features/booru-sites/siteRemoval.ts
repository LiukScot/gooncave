import type { useChoose } from '@/components/confirm-dialog';

type Choose = ReturnType<typeof useChoose>;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Asks before a site is removed. Resolves to what happens to the posts of the
 * site already downloaded on this device, or null when the person cancels.
 * Posts that are only online are removed without asking.
 */
export async function askSiteRemoval(
  choose: Choose,
  siteName: string,
  counts: { onlineOnly: number; downloaded: number }
): Promise<'keep' | 'delete' | null> {
  const online = counts.onlineOnly
    ? ` ${plural(counts.onlineOnly, 'post', 'posts')} of ${siteName} that this device only shows from sync will leave the library.`
    : '';
  if (counts.downloaded === 0) {
    const answer = await choose(
      `${siteName} is removed from this device and the devices that sync with it.${online}`,
      {
        title: `Remove ${siteName}?`,
        actions: [{ value: 'keep', label: 'Remove site', variant: 'destructive' }]
      }
    );
    return answer === 'keep' ? 'keep' : null;
  }
  return choose(
    `${siteName} is removed from this device and the devices that sync with it.${online} ${plural(counts.downloaded, 'post is', 'posts are')} also downloaded on this device. Other devices keep the files they downloaded.`,
    {
      title: `Remove ${siteName}?`,
      actions: [
        { value: 'keep', label: 'Remove site, keep downloaded files' },
        {
          value: 'delete',
          label: 'Remove site and delete downloaded files',
          variant: 'destructive'
        }
      ]
    }
  );
}
