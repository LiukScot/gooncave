import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps
} from 'react';

import { DOUBLE_TAP_MS, useTouchDoubleTap, videoThird } from './useDoubleTapFullscreen';
import { togglePlayback } from './videoLoop';

import { formatDuration } from '@/lib/format';

const clock = (seconds: number): string =>
  formatDuration(seconds * 1000) || '0:00';

/** How far along a slider is, for the filled part of its track. */
export const sliderProgress = (value: number, max: number): CSSProperties =>
  ({ '--progress': `${max > 0 ? (value / max) * 100 : 0}%` }) as CSSProperties;

/**
 * A <video> with the app's own control bar in place of the browser's, so the
 * bar takes the page's colours and icons. It renders the video and the bar
 * as siblings: the caller's layout still sees the <video> as its own child.
 *
 * Every platform uses the same bar so visibility and auto-hide stay in sync
 * with the detail view's actions.
 *
 * Fullscreen is not here. The detail view has its own button for it, which
 * sits at the end of this bar's row.
 */
export function VideoPlayer({
  ref,
  onTimeUpdate,
  onVolumeChange,
  skipSeconds = 10,
  ...props
}: ComponentProps<'video'> & {
  /** How far a double tap on the left or right third goes back or forward. */
  skipSeconds?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sound, setSound] = useState({ volume: 1, muted: false });
  // Keyed by a count, so a second skip the same way restarts the hint's fade.
  const [skip, setSkip] = useState<{ forward: boolean; count: number } | null>(null);

  const setRef = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref]
  );

  // A double tap or double click on either side skips, as video apps do; the middle is left
  // to the page (fullscreen).
  const skipFrom = (video: HTMLVideoElement, x: number): boolean => {
    const third = videoThird(video, x);
    if (third === 'middle') return false;
    const forward = third === 'forward';
    const end = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(
      end,
      Math.max(0, video.currentTime + (forward ? skipSeconds : -skipSeconds))
    );
    setSkip((current) => ({ forward, count: (current?.count ?? 0) + 1 }));
    return true;
  };
  const touchDoubleTapAt = useRef(-Infinity);
  const playPressedRef = useRef(false);
  const sideDoubleTap = useTouchDoubleTap((event, x) => {
    touchDoubleTapAt.current = performance.now();
    skipFrom(event.currentTarget as HTMLVideoElement, x);
  });

  const audible = sound.muted ? 0 : sound.volume;

  return (
    <>
      <video
        {...props}
        ref={setRef}
        controls={false}
        onDoubleClick={(event) => {
          // The dblclick some browsers make of a double tap already read from the touches.
          if (performance.now() - touchDoubleTapAt.current < 2 * DOUBLE_TAP_MS) return;
          if (skipFrom(event.currentTarget, event.clientX)) event.stopPropagation();
        }}
        onTouchStart={sideDoubleTap.onTouchStart}
        onTouchEnd={sideDoubleTap.onTouchEnd}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onDurationChange={(event) =>
          setDuration(event.currentTarget.duration || 0)
        }
        onLoadedMetadata={(event) => {
          // The caller sets the saved level before any event can report it.
          const { volume, muted } = event.currentTarget;
          setSound({ volume, muted });
        }}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          onTimeUpdate?.(event);
        }}
        onVolumeChange={(event) => {
          const { volume, muted } = event.currentTarget;
          setSound({ volume, muted });
          onVolumeChange?.(event);
        }}
      />
      {skip ? (
        <span
          key={skip.count}
          className={`video-skip-hint${skip.forward ? ' is-forward' : ''}`}
          aria-hidden="true"
        >
          {skip.forward ? `+${skipSeconds} s` : `−${skipSeconds} s`}
        </span>
      ) : null}
      {/* Over the middle of the picture, as video apps put it; it shows and hides with the bar. */}
      <button
        type="button"
        className={`file-detail-overlay-btn video-controls-play${playing ? ' is-playing' : ''}`}
        aria-label={playing ? 'Pause' : 'Play'}
        onPointerDown={() => {
          playPressedRef.current = true;
        }}
        onClick={(event) => {
          const pressed = playPressedRef.current;
          playPressedRef.current = false;
          // A tap that began on the picture while the button was hidden shows it, and the
          // browser can still send that tap's click here: only a press that began on the
          // button, or a key (detail 0), plays or pauses.
          if (!pressed && event.detail > 0) return;
          togglePlayback(videoRef.current);
        }}
      >
        {playing ? (
          <Pause className="file-detail-overlay-icon" aria-hidden="true" />
        ) : (
          <Play className="file-detail-overlay-icon" aria-hidden="true" />
        )}
      </button>
      <div className={`video-controls${playing ? ' is-playing' : ''}`}>
        <div className="video-controls-bar">
          <span className="video-controls-time">
            {clock(time)} / {clock(duration)}
          </span>
          <input
            type="range"
            className="video-range video-controls-seek"
            aria-label="Seek"
            min={0}
            max={duration}
            step="any"
            value={time}
            style={sliderProgress(time, duration)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setTime(next);
              if (videoRef.current) videoRef.current.currentTime = next;
            }}
          />
          <button
            type="button"
            className="video-controls-btn"
            aria-label={audible === 0 ? 'Unmute' : 'Mute'}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;
              if (audible > 0) {
                video.muted = true;
                return;
              }
              // Dragged to zero the bar mutes as well; unmuting has to bring a
              // level back, or the button changes nothing.
              video.muted = false;
              if (video.volume === 0) video.volume = 1;
            }}
          >
            {audible === 0 ? (
              <VolumeX aria-hidden="true" />
            ) : (
              <Volume2 aria-hidden="true" />
            )}
          </button>
          <input
            type="range"
            className="video-range video-controls-volume"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={audible}
            style={sliderProgress(audible, 1)}
            onChange={(event) => {
              const video = videoRef.current;
              if (!video) return;
              video.volume = Number(event.target.value);
              video.muted = video.volume === 0;
            }}
          />
        </div>
      </div>
    </>
  );
}
