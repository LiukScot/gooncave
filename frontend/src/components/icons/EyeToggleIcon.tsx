import { useId } from 'react';

/** An open eye that a slash draws across while `slashed`; the slash also cuts a gap in the eye. */
export function EyeToggleIcon({ slashed }: { slashed: boolean }) {
  const maskId = useId();
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`eye-toggle-icon${slashed ? ' is-slashed' : ''}`}
      aria-hidden="true"
    >
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" stroke="none" />
        <path className="eye-toggle-slash" d="m2 2 20 20" pathLength="1" stroke="black" strokeWidth="5" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
        <circle cx="12" cy="12" r="3" />
      </g>
      <path className="eye-toggle-slash" d="m2 2 20 20" pathLength="1" />
    </svg>
  );
}
