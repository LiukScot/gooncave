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

/** Icons a tile shows before the rest collapse into a "+N" badge. */
export const MAX_SOURCE_ICONS = 3;

/** The sources of a tile: the first few, then a badge counting the others. */
export function GallerySourceIconList({
  icons,
  activeKey
}: {
  icons: readonly GallerySourceIconValue[];
  activeKey?: string;
}) {
  const shown = icons.slice(0, MAX_SOURCE_ICONS);
  const active = icons.find((icon) => icon.key === activeKey);
  // The icon of the copy on screen must stay visible, whatever its position.
  if (active && !shown.includes(active)) shown[shown.length - 1] = active;
  const hidden = icons.filter((icon) => !shown.includes(icon));
  return (
    <>
      {shown.map((icon) => (
        <GallerySourceIcon key={icon.key} icon={icon} active={icon.key === activeKey} />
      ))}
      {hidden.length ? (
        <span
          className="gallery-source-icon gallery-source-icon-more"
          title={`${hidden.length} more: ${hidden.map((icon) => icon.label).join(', ')}`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </>
  );
}
