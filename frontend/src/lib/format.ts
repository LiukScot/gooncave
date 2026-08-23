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
