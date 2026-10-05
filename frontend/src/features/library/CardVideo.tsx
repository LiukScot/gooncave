import { Pause, Play } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';

import { sliderProgress } from '@/features/file-detail/VideoPlayer';

/**
 * A video playing inside a grid card (Gallery, Explore): muted, with a
 * play/pause chip and a time track and nothing else. The picture itself is
 * the way to the video's page, so a click on it opens the detail view.
 * `trailing` is the card's own chips (score, heart), which share the row
 * with the controls while the video plays.
 */
export function CardVideo({
  ref,
  src,
  testId,
  onOpen,
  trailing
}: {
  ref?: Ref<HTMLVideoElement>;
  src: string;
  testId: string;
  onOpen: () => void;
  trailing?: ReactNode;
}) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  return (
    <>
      <video
        ref={(element) => {
          setVideo(element);
          if (typeof ref === 'function') return ref(element);
          if (ref) ref.current = element;
        }}
        className="explore-card-video rounded"
        data-test-id={testId}
        src={src}
        autoPlay
        muted
        playsInline
        onClick={onOpen}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
      <div className="card-video-row">
        <button
          type="button"
          className="explore-action-btn card-video-play"
          aria-label={paused ? 'Play' : 'Pause'}
          onClick={() => {
            if (!video) return;
            if (!video.paused) {
              video.pause();
              return;
            }
            // A browser may refuse to start playback (no user gesture it
            // trusts, a source that cannot play); the button stays on Play.
            video.play().catch((error: unknown) => {
              console.warn('Could not play the card video', error);
            });
          }}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </button>
        <span className="card-video-track">
          <input
            className="video-range"
            aria-label="Seek"
            type="range"
            min={0}
            max={duration || 0}
            step="any"
            value={time}
            style={sliderProgress(time, duration)}
            onChange={(event) => {
              if (video) video.currentTime = Number(event.target.value);
            }}
          />
        </span>
        {trailing}
      </div>
    </>
  );
}
