// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cancelling remediations when versions are deleted (plan "Remediation and
 * deletion"): every LIVE remediation of the deleted versions — and of any
 * version a live remediation was about to replace with one of them (its
 * `to_plugin_id`) — ends `failed` / `cancelled`. Its queued job is removed, a
 * running one sees the stage change and stops before publishing, and a rollout
 * in progress is cancelled on the pipeline side (moved pipelines stay put).
 * Deleting a fix version leaves the version it fixed flagged, and the reverse.
 *
 * Not separately audited: the delete that caused it is (plugin.delete / plugin.delete-all).
 * Called by every delete path (DELETE /plugins/:id, bulk delete, by-name delete).
 */

import { createLogger, errorMessage, LIVE_REMEDIATION_STAGES, pluginRemediationJobId } from '@pipeline-builder/api-core';

import { countStage } from './lifecycle.js';
import { cancelRollout } from './rollout.js';
import { isRolloutStage, liveRemediationsTouching, updateRemediation } from './store.js';
import { getAllTierQueues } from '../../queue/connections.js';

const logger = createLogger('plugin-remediation-cancel');

/** Remove a remediation's queued jobs (build and approved-publish) from every tier queue. Best-effort. */
export async function removeQueuedRemediationJobs(remediationId: string): Promise<void> {
  const ids = [pluginRemediationJobId(remediationId), `${pluginRemediationJobId(remediationId)}-approved`];
  for (const { queue } of getAllTierQueues()) {
    for (const id of ids) {
      try {
        const job = await queue.getJob(id);
        if (job && !(await job.isActive())) await job.remove();
      } catch (err) {
        logger.debug('Queued remediation job not removed', { remediationId, error: errorMessage(err) });
      }
    }
  }
}

export async function cancelRemediationsFor(input: { orgId: string; pluginIds: string[]; reason: 'version_deleted' | 'name_deleted' }): Promise<number> {
  const rows = await liveRemediationsTouching(input.orgId, input.pluginIds);
  let n = 0;
  for (const row of rows) {
    const done = await updateRemediation(row.id, { stage: 'failed', outcome: 'cancelled', error: input.reason.toUpperCase(), finishedAt: new Date() }, LIVE_REMEDIATION_STAGES);
    if (!done) continue;
    n++;
    countStage('failed', 'cancelled');
    await removeQueuedRemediationJobs(row.id);
    if (isRolloutStage(row.stage)) await cancelRollout(row, input.reason);
  }
  return n;
}
