import {
  duplicatePolicyRepo,
  type DuplicatePolicyRequest
} from '../db/repos/duplicatePolicyRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';

import {
  applyDuplicatePolicyPreview,
  CONFIRMATION_REASON,
  createDuplicatePolicyPreview,
  DuplicatePolicyBusyError,
  DuplicatePolicyConflictError,
  queueDuplicatePolicyRun
} from './duplicatePolicy';

/** How often the worker looks for requests. Also the debounce of a burst. */
export const DUPLICATE_POLICY_POLL_MS = 2_000;

const runRequest = async (request: DuplicatePolicyRequest) => {
  let reasons = request.reasons;
  if (request.previewId) {
    try {
      await applyDuplicatePolicyPreview(
        request.userId,
        request.previewId,
        reasons.join(',')
      );
      // Triggers merged into the confirmation happened after the preview was
      // planned, so they still need a fresh plan.
      reasons = reasons.filter((reason) => reason !== CONFIRMATION_REASON);
      if (!reasons.length) return;
    } catch (error) {
      if (
        error instanceof DuplicatePolicyBusyError ||
        !(error instanceof DuplicatePolicyConflictError)
      ) {
        throw error;
      }
      // The confirmed preview expired while waiting. The policy it enabled is
      // saved, so a fresh plan below gives the same result.
    }
  }
  const settings = await favoritesRepo.getDuplicateSettings(request.userId);
  if (!settings.enabled || !settings.style) return;
  const preview = await createDuplicatePolicyPreview(request.userId, {
    style: settings.style,
    preferredProviders: settings.preferredProviders
  });
  if (!preview || preview.status !== 'ready') return;
  await applyDuplicatePolicyPreview(
    request.userId,
    preview.id,
    `automatic:${reasons.join(',')}`
  );
};

let processing: Promise<void> | null = null;

/**
 * One pass over the waiting requests, worker only. Users run side by side,
 * one run per user. A request renewed while its run was in progress keeps its
 * row and is served on the next pass; one whose user still has a run in
 * progress waits as well.
 */
export const processDuplicatePolicyRequests = (): Promise<void> => {
  processing ??= Promise.all(
    duplicatePolicyRepo.listRequests().map(async (request) => {
      if (duplicatePolicyRepo.hasActiveApplyRun(request.userId)) return;
      try {
        await runRequest(request);
      } catch (error) {
        if (error instanceof DuplicatePolicyBusyError) return;
        console.error('[duplicate-policy] run failed', {
          userId: request.userId,
          reasons: request.reasons,
          error: (error as Error).message
        });
      }
      duplicatePolicyRepo.deleteRequest(request.userId, request.requestedAt);
    })
  )
    .then(() => undefined)
    .finally(() => {
      processing = null;
    });
  return processing;
};

export const recoverDuplicatePolicyRunsOnStartup = () => {
  const users = duplicatePolicyRepo.recoverInterruptedRuns();
  for (const userId of users) {
    queueDuplicatePolicyRun(userId, 'resume-after-restart');
  }
  return users.length;
};
