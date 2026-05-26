import type { FileItem } from '@/api';

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

export const fileTypeFromPath = (value: string, mediaType: FileItem['mediaType']): string => {
  const name = basenameFromPath(value);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1).toUpperCase();
  }
  return mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
};

export const formatSizeMb = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(2)} MB`;
