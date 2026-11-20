// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The builds and remediations of ONE plugin name in one org that are still in
 * the queues — what a by-name delete cancels before it touches a version
 * (routes/plugin-by-name.ts, under the name lock).
 *
 * - Queued (waiting / delayed / prioritized / waiting-children, in every tier queue and
 *   the DLQ): removed. A build's reserved `plugins` slot is given back and its
 *   staged context dropped, exactly as a DLQ eviction does; a remediation job
 *   owns neither (no credits, no plugin-count slot).
 * - Running (active): waited for, up to `PLUGIN_DELETE_INFLIGHT_WAIT_MS`. One
 *   still running after that cannot land a version anyway: the store refuses
 *   under the name lock (services/version-persist.ts), terminally.
 */

import { createLogger, errorMessage, PLUGIN_REMEDIATION_JOB_NAME, type QuotaService } from '@pipeline-builder/api-core';
import type { Job, JobType, Queue } from 'bullmq';

// Namespace imports: suites mocking these modules with only what they use still link.
import * as buildQuota from './build-quota.js';
import * as workspace from './build-workspace.js';
import * as connections from './connections.js';
import type { PluginBuildJobData } from '../helpers/plugin-helpers.js';

const logger = createLogger('plugin-name-inflight');

const QUEUED: JobType[] = ['waiting', 'delayed', 'prioritized', 'waiting-children'];
const RUNNING: JobType[] = ['active'];
/** How often a wait for running jobs looks again. */
export const INFLIGHT_POLL_MS = 2_000;

/** Remediation job data (api-core `PluginRemediationJobData`) as it rides the build queue. */
interface RemediationJobLike { kind?: unknown; orgId?: unknown; pluginName?: unknown }

type AnyJob = Job<PluginBuildJobData | RemediationJobLike>;

function isRemediation(job: AnyJob): boolean {
  return job.name === PLUGIN_REMEDIATION_JOB_NAME || (job.data as RemediationJobLike)?.kind === 'plugin-remediation';
}

/** Whether `job` builds or remediates `name` in `orgId`. */
function forName(job: AnyJob, orgId: string, name: string): boolean {
  const org = orgId.toLowerCase();
  if (isRemediation(job)) {
    const d = job.data as RemediationJobLike;
    return String(d.orgId ?? '').toLowerCase() === org && d.pluginName === name;
  }
  const d = job.data as PluginBuildJobData;
  return String(d?.orgId ?? '').toLowerCase() === org && d?.pluginRecord?.name === name;
}

function queues(): Array<Queue<PluginBuildJobData>> {
  return [...connections.getAllTierQueues().map((q) => q.queue), connections.getDeadLetterQueue()];
}

async function jobsOf(types: JobType[], orgId: string, name: string): Promise<AnyJob[]> {
  const out: AnyJob[] = [];
  for (const q of queues()) {
    const jobs = (await q.getJobs(types)) as unknown as AnyJob[];
    for (const j of jobs) if (j && forName(j, orgId, name)) out.push(j);
  }
  return out;
}

/** Queued + running builds and remediations of `name` (the delete preview's `inFlight`). */
export async function countInFlight(orgId: string, name: string): Promise<{ builds: number; remediations: number }> {
  const jobs = await jobsOf([...QUEUED, ...RUNNING], orgId, name);
  const remediations = jobs.filter(isRemediation).length;
  return { builds: jobs.length - remediations, remediations };
}

/**
 * Remove every QUEUED build and remediation of `name`, releasing what each
 * build held. Returns how many of each went. A job that could not be removed
 * (it started meanwhile) is left for {@link waitForRunning}.
 */
export async function cancelQueued(orgId: string, name: string, quotaService: QuotaService): Promise<{ builds: number; remediations: number }> {
  let builds = 0;
  let remediations = 0;
  for (const job of await jobsOf(QUEUED, orgId, name)) {
    try {
      await job.remove();
    } catch (err) {
      logger.warn('A queued job of a deleted plugin could not be removed (it may have started)', { jobId: job.id, error: errorMessage(err) });
      continue;
    }
    if (isRemediation(job)) {
      remediations++;
      continue;
    }
    builds++;
    const build = job as Job<PluginBuildJobData>;
    buildQuota.releasePluginQuota(build, quotaService);
    if (build.data.buildRequest) workspace.cleanupBuildArtifacts(build.data.buildRequest);
  }
  if (builds + remediations > 0) logger.info('Cancelled queued jobs of a plugin being deleted', { orgId, name, builds, remediations });
  return { builds, remediations };
}

/**
 * Wait until no build or remediation of `name` is running, at most `maxWaitMs`.
 * Resolves with how many were still running when it gave up (0 = none left).
 */
export async function waitForRunning(orgId: string, name: string, maxWaitMs: number, pollMs = INFLIGHT_POLL_MS): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const running = (await jobsOf(RUNNING, orgId, name)).length;
    if (running === 0) return 0;
    if (Date.now() >= deadline) {
      logger.warn('Builds of a plugin being deleted still running after the wait; the store will refuse them under the name lock', { orgId, name, running });
      return running;
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
