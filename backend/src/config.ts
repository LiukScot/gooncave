import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const defaultMediaPath = () => {
  const envMediaPath = process.env.MEDIA_PATH;
  if (envMediaPath && envMediaPath.length > 0) return envMediaPath;
  if ((process.env.NODE_ENV ?? 'development') === 'production') return '/gooncave-library';
  return path.resolve(process.cwd(), '..', 'gooncave-library');
};

const toInt = (value: string | undefined, fallback: number): number => {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const toBool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: toInt(process.env.PORT, 4100),
  folderPaths: toList(process.env.FOLDER_PATHS),
  mediaPath: defaultMediaPath(),
  frontendDir: process.env.FRONTEND_DIR ?? 'public',
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? '',
    pass: process.env.DB_PASS ?? '',
    name: process.env.DB_NAME ?? 'imagesearch'
  },
  storage: {
    thumbnailsDir: process.env.THUMBNAILS_DIR ?? 'storage/thumbnails',
    dataFile: process.env.DATA_FILE ?? 'storage/data.db'
  },
  tagger: {
    url: process.env.TAGGER_URL ?? 'http://tagger:8000'
  },
  e621: {
    username: process.env.E621_USERNAME ?? '',
    apiKey: process.env.E621_API_KEY ?? '',
    userAgent: process.env.E621_USER_AGENT ?? 'GoonCave (made by liukscot)'
  },
  danbooru: {
    username: process.env.DANBOORU_USERNAME ?? '',
    apiKey: process.env.DANBOORU_API_KEY ?? ''
  },
  gelbooru: {
    userId: process.env.GELBOORU_USER_ID ?? '',
    apiKey: process.env.GELBOORU_API_KEY ?? ''
  },
  saucenao: {
    apiKey: process.env.SAUCENAO_API_KEY ?? ''
  },
  favorites: {
    root: process.env.FAVORITES_ROOT ?? '',
    syncIntervalMs: toInt(process.env.FAVORITES_SYNC_INTERVAL_HOURS, 24) * 60 * 60 * 1000,
    deleteMissing: toBool(process.env.FAVORITES_DELETE_MISSING, true),
    debug: toBool(process.env.FAVORITES_DEBUG, false)
  },
  auth: {
    cookieName: process.env.AUTH_COOKIE_NAME ?? 'gooncave_session',
    sessionTtlMs: toInt(process.env.AUTH_SESSION_TTL_HOURS, 24) * 60 * 60 * 1000,
    usersRootDirName: process.env.AUTH_USERS_DIR_NAME ?? 'users'
  },
  background: {
    localRescanIntervalMs: toInt(process.env.LOCAL_RESCAN_INTERVAL_MINUTES, 0) * 60 * 1000
  },
  wd14: {
    backfillIntervalHours: toInt(process.env.WD14_BACKFILL_INTERVAL_HOURS, 6)
  }
};
