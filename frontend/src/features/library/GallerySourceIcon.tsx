import { Globe2, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';

import type { GallerySourceIcon as GallerySourceIconValue } from './gallerySourceIcons';

export function GallerySourceIcon({
  icon,
  active = false
}: {
  icon: GallerySourceIconValue;
  active?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      className={`gallery-source-icon${active ? ' is-active' : ''}`}
      title={icon.label}
    >
      {icon.iconUrl && !broken ? (
        <img
          src={icon.iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : icon.key === 'local' ? (
        <ImageIcon aria-hidden="true" />
      ) : (
        <Globe2 aria-hidden="true" />
      )}
    </span>
  );
}
