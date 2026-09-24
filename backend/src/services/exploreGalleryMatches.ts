import { favoritesRepo } from '../db/repos/favoritesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import {
  buildImageSignatureForPath,
  compareImageSignatureBuffers
} from '../lib/duplicates';
import { averageHash } from '../lib/scanner';
import { mapWithConcurrency } from '../lib/taskPool';

import { remoteMediaCache } from './remoteMedia';

const MATCH_CONCURRENCY = 4;
const MAX_HASH_DISTANCE = 2;
const MAX_RATIO_DIFFERENCE = 0.03;
const MAX_PIXEL_DIFFERENCE = 0.01;

export type GalleryMatchCandidate = {
  key: string;
  url: string | null;
  width: number | null;
  height: number | null;
  fileExt: string | null;
};

const bitCount = (value: number): number => {
  let remaining = value;
  let count = 0;
  while (remaining) {
    count += remaining & 1;
    remaining >>>= 1;
  }
  return count;
};

export const hashDistance = (left: string, right: string): number => {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += bitCount(
      Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16)
    );
  }
  return distance;
};

const comparableRatio = (
  candidate: GalleryMatchCandidate,
  local: { width: number; height: number }
) => {
  if (!candidate.width || !candidate.height) return false;
  const remoteRatio = candidate.width / candidate.height;
  const localRatio = local.width / local.height;
  return Math.abs(remoteRatio / localRatio - 1) <= MAX_RATIO_DIFFERENCE;
};

export const matchesFavoriteFingerprint = (
  remoteHash: string,
  candidate: GalleryMatchCandidate,
  fingerprints: Array<{ phash: string; width: number; height: number }>
): boolean =>
  fingerprints.some(
    (local) =>
      comparableRatio(candidate, local) &&
      hashDistance(remoteHash, local.phash) <= MAX_HASH_DISTANCE
  );

const matchingFingerprintCandidates = (
  remoteHash: string,
  candidate: GalleryMatchCandidate,
  fingerprints: Array<{
    path: string;
    phash: string;
    width: number;
    height: number;
  }>
) =>
  fingerprints.filter(
    (local) =>
      comparableRatio(candidate, local) &&
      hashDistance(remoteHash, local.phash) <= MAX_HASH_DISTANCE
  );

export const findGalleryFavoriteMatchKeys = async (
  userId: string,
  candidates: GalleryMatchCandidate[]
): Promise<Set<string>> => {
  const settings = await favoritesRepo.getDuplicateSettings(userId);
  if (!settings.enabled || settings.style !== 'favorite_all') return new Set();
  const fingerprints = filesRepo.listFavoriteImageFingerprints(userId);
  if (!fingerprints.length) return new Set();
  const localSignatures = new Map<string, Promise<Uint8Array | null>>();

  const matches = await mapWithConcurrency(
    candidates,
    MATCH_CONCURRENCY,
    async (candidate) => {
      if (
        !candidate.url ||
        !candidate.width ||
        !candidate.height ||
        ['gif', 'mp4', 'webm', 'm4v', 'mov'].includes(
          candidate.fileExt?.toLowerCase() ?? ''
        )
      ) {
        return null;
      }
      try {
        const cached = await remoteMediaCache.load(candidate.url);
        const remoteHash = await averageHash(cached.filePath);
        const plausible = matchingFingerprintCandidates(
          remoteHash,
          candidate,
          fingerprints
        );
        if (!plausible.length) return null;
        const remoteSignature = await buildImageSignatureForPath(cached.filePath);
        if (!remoteSignature) return null;
        for (const local of plausible) {
          let signature = localSignatures.get(local.path);
          if (!signature) {
            signature = buildImageSignatureForPath(local.path);
            localSignatures.set(local.path, signature);
          }
          const localSignature = await signature;
          if (
            localSignature &&
            compareImageSignatureBuffers(remoteSignature, localSignature) <=
              MAX_PIXEL_DIFFERENCE
          ) {
            return candidate.key;
          }
        }
        return null;
      } catch (error) {
        console.warn(
          `[explore-gallery-match] ${candidate.key} skipped: ${(error as Error).message}`
        );
        return null;
      }
    }
  );
  return new Set(matches.filter((key): key is string => key !== null));
};
