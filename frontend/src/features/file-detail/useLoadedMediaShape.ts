import { useCallback, useState, type SyntheticEvent } from 'react';

/**
 * The shape the open picture or video really has, once it has loaded. The box is reserved
 * from the site's or the library's width and height, and those can be wrong (a file that was
 * replaced, a sample of another shape): the box then has the wrong shape and the thumbnail
 * under the picture shows past its edge.
 *
 * `aspect` is `"W / H"` for `--file-detail-aspect`, or null until the media for `itemKey` has
 * loaded. The handlers go on the media wrap, where they hear its picture's or video's load.
 */
export function useLoadedMediaShape(itemKey: string | null) {
  const [loaded, setLoaded] = useState<{ key: string | null; aspect: string } | null>(null);
  const remember = useCallback(
    (width: number, height: number) => {
      if (width > 0 && height > 0) setLoaded({ key: itemKey, aspect: `${width} / ${height}` });
    },
    [itemKey]
  );
  const onLoadCapture = useCallback(
    (event: SyntheticEvent) => {
      if (event.target instanceof HTMLImageElement) {
        remember(event.target.naturalWidth, event.target.naturalHeight);
      }
    },
    [remember]
  );
  const onLoadedMetadataCapture = useCallback(
    (event: SyntheticEvent) => {
      if (event.target instanceof HTMLVideoElement) {
        remember(event.target.videoWidth, event.target.videoHeight);
      }
    },
    [remember]
  );
  return {
    aspect: loaded && loaded.key === itemKey ? loaded.aspect : null,
    handlers: { onLoadCapture, onLoadedMetadataCapture }
  };
}
