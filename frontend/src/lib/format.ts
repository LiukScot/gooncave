export const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

export const basenameFromPath = (value: string): string => {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
};

export const fileTypeFromPath = (
  value: string,
  mediaType: 'IMAGE' | 'VIDEO'
): string => {
  const name = basenameFromPath(value);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1).toUpperCase();
  }
  return mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
};

/** A size in decimal units (1 kB = 1000 bytes), whole below MB: 1536 -> "2 kB", 1_500_000 -> "1.5 MB". */
export const formatBytes = (bytes: number): string => {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(undefined, {
    style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit < 2 ? 0 : 1
  }).format(value);
};

export const formatSizeMb = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.00 MB';
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

/**
 * Clock-style duration, e.g. 45s -> "0:45", 125s -> "2:05", 1h -> "1:00:00".
 * Rounds to the nearest second; a non-positive or unusable value gives "".
 */
export const formatDuration = (ms: number | null | undefined): string => {
  if (!Number.isFinite(ms) || (ms as number) <= 0) return '';
  const total = Math.round((ms as number) / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};
