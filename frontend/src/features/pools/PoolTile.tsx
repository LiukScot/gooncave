import { Play } from 'lucide-react';
import React from 'react';

import type { PoolPagePost } from '@/api';
import { isVideoUrl } from '@/features/explore/exploreMedia';

/** One page of a pool: the picture, and where it sits in the reading order. */
export function PoolTile({
  post,
  onOpen
}: {
  post: PoolPagePost;
  onOpen: () => void;
}): React.ReactElement {
  const thumbUrl = post.previewUrl ?? post.sampleUrl;
  const isVideo = isVideoUrl(post.fileUrl);
  return (
    <div className="pool-tile">
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left w-full h-full"
        data-test-id="pool-tile"
        aria-label={`Open page ${post.position} of the pool${
          post.localFileId ? ', in your library' : ''
        }`}
        onClick={onOpen}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={`Page ${post.position}`}
            className="pool-tile-img rounded"
            loading="lazy"
            decoding="async"
            // danbooru's CDN answers 403 without a Referer; `origin` sends
            // the host and never the path.
            referrerPolicy="origin"
          />
        ) : (
          <div className="pool-tile-blank rounded">no preview</div>
        )}
      </button>
      {isVideo && thumbUrl ? (
        <Play
          aria-hidden="true"
          fill="currentColor"
          className="absolute inset-0 m-auto size-10 rounded-full bg-background/70 p-2 text-foreground"
        />
      ) : null}
      {/* Bottom left: the reading order is what this grid is for, so the
          number stays on screen even where a tile is mostly white. */}
      <span className="gallery-chip gallery-chip-bottom left-2">
        {post.position}
      </span>
      {post.localFileId ? (
        <span className="gallery-chip right-2" title="In your library">
          saved
        </span>
      ) : null}
    </div>
  );
}
