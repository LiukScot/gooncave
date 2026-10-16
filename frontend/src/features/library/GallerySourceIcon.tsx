import { Globe2, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';

import {
  visibleSourceIcons,
  type GallerySourceIcon as GallerySourceIconValue
} from './gallerySourceIcons';

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

/** At most three icons, then a +N badge; the parent's label names every source. */
export function GallerySourceIconList({
  icons,
  activeKey
}: {
  icons: GallerySourceIconValue[];
  activeKey?: string;
}) {
  const { shown, hidden } = visibleSourceIcons(icons, activeKey);
  return (
    <>
      {shown.map((icon) => (
        <GallerySourceIcon
          key={icon.key}
          icon={icon}
          active={activeKey !== undefined && icon.key === activeKey}
        />
      ))}
      {hidden ? (
        <span className="gallery-source-icon gallery-source-more" aria-hidden="true">
          +{hidden}
        </span>
      ) : null}
    </>
  );
}
