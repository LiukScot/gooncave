import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentProps
} from 'react';

import { togglePlayback } from './videoLoop';

import { formatDuration } from '@/lib/format';

const clock = (seconds: number): string =>
  formatDuration(seconds * 1000) || '0:00';

// How long a click waits for a second one. Shorter than the system's
// double-click interval would let slow double clicks through as two singles;
// longer makes a tap-to-pause feel late.
const DOUBLE_CLICK_MS = 250;

/** How far along a slider is, for the filled part of its track. */
export const sliderProgress = (value: number, max: number): CSSProperties =>
  ({ '--progress': `${max > 0 ? (value / max) * 100 : 0}%` }) as CSSProperties;

/**
 * A <video> with the app's own control bar in place of the browser's, so the
 * bar takes the page's colours and icons. It renders the video and the bar
 * as siblings: the caller's layout still sees the <video> as its own child.
 *
 * Fullscreen is not here. The detail view has its own button for it, which
 * sits at the end of this bar's row.
 */
export function VideoPlayer({
  ref,
  onTimeUpdate,
  onVolumeChange,
  ...props
}: ComponentProps<'video'>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sound, setSound] = useState({ volume: 1, muted: false });
  const clickTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clickTimerRef.current), []);

  const setRef = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      if (typeof ref === 'function') ref(element);
      else if (ref) ref.current = element;
    },
    [ref]
  );

  const audible = sound.muted ? 0 : sound.volume;

  return (
    <>
      <video
        {...props}
        ref={setRef}
        onClick={(event) => {
          // A double click belongs to the page (fullscreen), so a single one
          // waits to see that no second click follows before it plays or
          // pauses.
          window.clearTimeout(clickTimerRef.current);
          if (event.detail > 1) return;
          const video = event.currentTarget;
          clickTimerRef.current = window.setTimeout(
            () => togglePlayback(video),
            DOUBLE_CLICK_MS
          );
        }}
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
      <div className={`video-controls${playing ? ' is-playing' : ''}`}>
        <button
          type="button"
          className="file-detail-overlay-btn video-controls-play"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => togglePlayback(videoRef.current)}
        >
          {playing ? (
            <Pause className="file-detail-overlay-icon" aria-hidden="true" />
          ) : (
            <Play className="file-detail-overlay-icon" aria-hidden="true" />
          )}
        </button>
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
