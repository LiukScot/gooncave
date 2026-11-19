import { useId } from 'react';

const WIDTH = 240;
const WAVELENGTH = 20;
const GAP = 6;
const END = WIDTH - 2;
// One wavelength beyond each end, so the wave can shift by one wavelength and loop.
const WAVE = Array.from({ length: (WIDTH + 2 * WAVELENGTH) / 2 + 1 }, (_, i) => {
  const x = i * 2 - WAVELENGTH;
  const y = 8 + 3 * Math.sin((x / WAVELENGTH) * 2 * Math.PI);
  return `${i === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`;
}).join(' ');

const SEGMENT = 72;

/**
 * A progress bar whose filled part is a moving wave: `read` of `total` done. Without them the
 * amount is unknown, and a stretch of wave travels along the track. With reduced motion the
 * wave stands still.
 */
export function WavyProgress({
  read,
  total,
  label
}: {
  read?: number;
  total?: number;
  label: string;
}) {
  const clip = useId();
  if (read === undefined || total === undefined) {
    return (
      <svg
        className="wavy-progress"
        viewBox={`0 0 ${WIDTH} 16`}
        role="progressbar"
        aria-label={label}
      >
        <clipPath id={`${clip}-wave`}>
          <rect className="wavy-progress-travel" x={0} y={0} width={SEGMENT} height={16} />
        </clipPath>
        <mask id={`${clip}-rest`} maskUnits="userSpaceOnUse" x={0} y={0} width={WIDTH} height={16}>
          <rect x={0} y={0} width={WIDTH} height={16} fill="white" />
          <rect
            className="wavy-progress-travel"
            x={-GAP}
            y={0}
            width={SEGMENT + 2 * GAP}
            height={16}
            fill="black"
          />
        </mask>
        <line
          className="wavy-progress-rest"
          x1={2}
          y1={8}
          x2={END}
          y2={8}
          mask={`url(#${clip}-rest)`}
        />
        <g clipPath={`url(#${clip}-wave)`}>
          <path className="wavy-progress-wave" d={WAVE} />
        </g>
      </svg>
    );
  }
  const ratio = total > 0 ? Math.min(1, read / total) : 0;
  const filled = Math.max(2, ratio * END);
  return (
    <svg
      className="wavy-progress"
      viewBox={`0 0 ${WIDTH} 16`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={read}
    >
      <clipPath id={clip}>
        <rect className="wavy-progress-fill" x={0} y={0} width={filled} height={16} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <path className="wavy-progress-wave" d={WAVE} />
      </g>
      {ratio < 1 && (
        <>
          <line
            className="wavy-progress-rest"
            x1={Math.min(END, filled + GAP)}
            y1={8}
            x2={END}
            y2={8}
          />
          <circle className="wavy-progress-end" cx={END} cy={8} r={2} />
        </>
      )}
    </svg>
  );
}
