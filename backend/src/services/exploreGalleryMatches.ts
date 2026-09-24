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
const FINGERPRINT_PAGE_SIZE = 500;
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
    id: string;
    path: string;
    thumb_path: string | null;
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
  if (!candidates.length) return new Set();
  let fingerprints = filesRepo.listFavoriteImageFingerprintsPage(
    userId,
    null,
    FINGERPRINT_PAGE_SIZE
  );
  if (!fingerprints.length) return new Set();
  const localSignatures = new Map<string, Promise<Uint8Array | null>>();
  const localSignatureFor = async (local: {
    path: string;
    thumb_path: string | null;
  }) => {
    for (const readablePath of [local.path, local.thumb_path]) {
      if (!readablePath) continue;
      let signature = localSignatures.get(readablePath);
      if (!signature) {
        signature = buildImageSignatureForPath(readablePath);
        localSignatures.set(readablePath, signature);
      }
      const resolved = await signature;
      if (resolved) return resolved;
    }
    return null;
  };

  const remotes = await mapWithConcurrency(
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
        return { candidate, cachedPath: cached.filePath, remoteHash };
      } catch (error) {
        console.warn(
          `[explore-gallery-match] ${candidate.key} skipped: ${(error as Error).message}`
        );
        return null;
      }
    }
  );
  const unmatched = remotes.filter(
    (remote): remote is NonNullable<typeof remote> => remote !== null
  );
  const matches = new Set<string>();
  const remoteSignatures = new Map<string, Promise<Uint8Array | null>>();

  while (unmatched.length) {
    for (let index = unmatched.length - 1; index >= 0; index -= 1) {
      const remote = unmatched[index];
      const plausible = matchingFingerprintCandidates(
        remote.remoteHash,
        remote.candidate,
        fingerprints
      );
      if (!plausible.length) continue;
      let remoteSignature = remoteSignatures.get(remote.candidate.key);
      if (!remoteSignature) {
        remoteSignature = buildImageSignatureForPath(remote.cachedPath);
        remoteSignatures.set(remote.candidate.key, remoteSignature);
      }
      const resolvedRemoteSignature = await remoteSignature;
      if (!resolvedRemoteSignature) {
        unmatched.splice(index, 1);
        continue;
      }
      for (const local of plausible) {
        const resolvedLocalSignature = await localSignatureFor(local);
        if (
          resolvedLocalSignature &&
          compareImageSignatureBuffers(
            resolvedRemoteSignature,
            resolvedLocalSignature
          ) <= MAX_PIXEL_DIFFERENCE
        ) {
          matches.add(remote.candidate.key);
          unmatched.splice(index, 1);
          break;
        }
      }
    }
    if (fingerprints.length < FINGERPRINT_PAGE_SIZE) break;
    const afterId = fingerprints[fingerprints.length - 1].id;
    fingerprints = filesRepo.listFavoriteImageFingerprintsPage(
      userId,
      afterId,
      FINGERPRINT_PAGE_SIZE
    );
    if (!fingerprints.length) break;
  }
  return matches;
};
