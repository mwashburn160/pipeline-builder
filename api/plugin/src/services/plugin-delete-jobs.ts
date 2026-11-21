// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Delete plugin" as a background job (routes/plugin-by-name.ts).
 *
 * The delete waits for the name's running builds (up to
 * `PLUGIN_DELETE_INFLIGHT_WAIT_MS`), far longer than a request should be held
 * open, so `DELETE /plugins/by-name/:name` answers 202 `{ batchId, jobId }` once
 * the delete is ACCEPTED and runs the rest on the replica that took it:
 *
 * - accepted = the managed-name refusal passed, the name lock is held, the org
 *   has live versions of the name and the caller may delete every one of them.
 *   Each of those refusals still answers the request itself (400 / 409 / 404 /
 *   403), with nothing touched — only an accepted delete becomes a job;
 * - the job is {@link deleteByName} from there on: cancel queued builds and
 *   remediations, wait for running builds, soft-delete under `batchId`, refund,
 *   audit (`plugin.delete` per version, one `plugin.delete-all`), notify.
 *
 * Status lives in Redis (db 0, beside the name lock) under the org, so any
 * replica answers `GET /plugins/by-name/:name/delete-jobs/:jobId` and another
 * org's job id is a 404. It is kept {@link DELETE_JOB_TTL_SECONDS}. While it
 * runs the job re-stamps `heartbeatAt`; a running job whose heartbeat is older
 * than {@link DELETE_JOB_STALE_MS} (its replica died) reads as `failed` — the
 * name lock it held expires on its own TTL.
 */

import { randomUUID } from 'node:crypto';

import { AppError, createLogger, errorMessage, type PluginDeleteJobAccepted, type PluginDeleteJobStatus, type QuotaService } from '@pipeline-builder/api-core';

import { deleteByName, type NameActionCaller } from './plugin-name-actions.js';
// A namespace import: suites that mock the queue connections with only the
// exports they use still link this module.
import * as connections from '../queue/connections.js';

const logger = createLogger('plugin-delete-jobs');

/** How long a job's status can be read after it starts. */
export const DELETE_JOB_TTL_SECONDS = 24 * 60 * 60;
/** How often a running job re-stamps its heartbeat. */
export const DELETE_JOB_HEARTBEAT_MS = 30_000;
/** A running job with no heartbeat for this long has lost its replica. */
export const DELETE_JOB_STALE_MS = 4 * DELETE_JOB_HEARTBEAT_MS;

/** What is stored: the wire status plus the heartbeat. */
type StoredJob = PluginDeleteJobStatus & { heartbeatAt: string };

/** The Redis key of one org's delete job. */
export function deleteJobKey(orgId: string, jobId: string): string {
  return `plugin-delete-job:${orgId.toLowerCase()}:${jobId}`;
}

async function writeJob(orgId: string, job: StoredJob): Promise<void> {
  await connections.getConnectionForDb(0).set(deleteJobKey(orgId, job.jobId), JSON.stringify(job), 'EX', DELETE_JOB_TTL_SECONDS);
}

/** Write a terminal state, once more on failure: a lost final write would leave the job reading as `failed` once its heartbeat goes stale. */
async function writeFinal(orgId: string, job: StoredJob): Promise<void> {
  try {
    await writeJob(orgId, job);
  } catch {
    try {
      await writeJob(orgId, job);
    } catch (err) {
      logger.error('Could not record the outcome of a plugin delete job', { orgId, jobId: job.jobId, state: job.state, error: errorMessage(err) });
    }
  }
}

/** The status of `jobId` for the org's plugin `name`, or null (unknown, expired, another org's, another name's). */
export async function readDeleteJob(orgId: string, name: string, jobId: string, now: Date = new Date()): Promise<PluginDeleteJobStatus | null> {
  const raw = await connections.getConnectionForDb(0).get(deleteJobKey(orgId, jobId));
  if (!raw) return null;
  let stored: StoredJob;
  try {
    stored = JSON.parse(raw) as StoredJob;
  } catch {
    return null;
  }
  if (stored.name !== name || stored.jobId !== jobId) return null;
  const { heartbeatAt, ...job } = stored;
  if (job.state === 'running' && now.getTime() - Date.parse(heartbeatAt) > DELETE_JOB_STALE_MS) {
    return { ...job, state: 'failed', error: { code: null, message: 'The delete stopped reporting progress (its server restarted). Check Recently deleted and try again.' } };
  }
  return job;
}

export interface StartedDeleteJob extends PluginDeleteJobAccepted {
  /** Settles when the job does (never rejects: a failure is recorded as the job's state). */
  done: Promise<void>;
}

/**
 * Start a whole-plugin delete. Resolves once it is accepted (see the module
 * comment) with the batch and job ids; rejects with the refusal otherwise, in
 * which case nothing was touched and no job exists.
 */
export function startDeleteJob(name: string, caller: NameActionCaller, opts: { force: boolean; quotaService: QuotaService }): Promise<StartedDeleteJob> {
  const { orgId } = caller;
  const batchId = randomUUID();
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const base = (): StoredJob => ({
    jobId,
    name,
    batchId,
    state: 'running',
    force: opts.force,
    startedAt,
    finishedAt: null,
    deleted: [],
    skipped: [],
    error: null,
    heartbeatAt: new Date().toISOString(),
  });

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let accepted = false;
  return new Promise<StartedDeleteJob>((resolve, reject) => {
    let done!: Promise<void>;
    const onAccepted = async (): Promise<void> => {
      // A status write that fails here refuses the delete with nothing touched.
      await writeJob(orgId, base());
      accepted = true;
      heartbeat = setInterval(() => {
        writeJob(orgId, base()).catch((err: unknown) => logger.warn('Could not stamp a plugin delete job heartbeat', { orgId, jobId, error: errorMessage(err) }));
      }, DELETE_JOB_HEARTBEAT_MS);
      heartbeat.unref?.();
      // Answer the request now; the delete carries on in this async context
      // (tenant, request id and actor stay with it).
      resolve({ batchId, jobId, done });
    };
    done = deleteByName(name, caller, { ...opts, batchId, onAccepted }).then(
      async ({ cancelled, ...result }) => {
        clearInterval(heartbeat);
        await writeFinal(orgId, { ...base(), state: 'succeeded', finishedAt: new Date().toISOString(), deleted: result.deleted, skipped: result.skipped });
        logger.info('Plugin delete job finished', { orgId, name, jobId, batchId, deleted: result.deleted.length, skipped: result.skipped.length, ...cancelled });
      },
      async (err: unknown) => {
        clearInterval(heartbeat);
        if (!accepted) {
          reject(err);
          return;
        }
        logger.error('Plugin delete job failed', { orgId, name, jobId, batchId, error: errorMessage(err) });
        await writeFinal(orgId, {
          ...base(),
          state: 'failed',
          finishedAt: new Date().toISOString(),
          error: { code: err instanceof AppError ? err.code : null, message: errorMessage(err) },
        });
      },
    );
  });
}
