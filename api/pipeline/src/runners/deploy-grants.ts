// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy job's credentials.
 *
 *  - The GRANT (`pb_dg_` + 32 random bytes, base64url) is minted at queue time
 *    and rides only in the signed claim (the runner KMS-wraps it for its build).
 *    The platform keeps its sha256 and — for re-signing on a redelivery — the
 *    grant under the org's `encryptSecret`, wiped at the exchange and at any
 *    terminal status. It is single use and expires
 *    ({@link deployGrantTtlMs}: the build queue + provisioning, never shorter
 *    than the delivery lifetime).
 *  - The job's first call trades it for a SESSION token (`pb_ds_…`, opaque,
 *    sha256 stored, valid to the deploy deadline): the only credential the
 *    facade under `/api/pipelines/runner/deploys/:requestId/…` accepts, and
 *    only for its own request id.
 *
 * Refusals are 401 DEPLOY_GRANT_INVALID with `details.reason` (reused |
 * expired | unknown | wrong_state). A grant presented AGAIN after its exchange
 * is the signal that it leaked: counted (`reason="reused"` pages
 * RunnerDeployGrantReuse) and audited `pipeline.deploy.grant_reuse`. Neither
 * token, nor its hash, ever reaches a log, an audit entry or a metric label.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SYSTEM_ACTOR_ID } from '@pipeline-builder/api-core';
import {
  DEPLOY_GRANT_PATTERN, DEPLOY_GRANT_PREFIX, DEPLOY_JOB_PROTOCOL_VERSION, DEPLOY_SESSION_PATTERN, DEPLOY_SESSION_PREFIX, DEPLOY_TOKEN_RANDOM_BYTES,
  IN_PROGRESS_RUN_REQUEST_STATUSES, PENDING_RUN_REQUEST_STATUSES, RUNNER_DEPLOY_METRICS,
  type DeployGrantRejectionReason, type DeploySessionDto, type RunRequestStatus,
} from '@pipeline-builder/api-core/pipeline-runners';
import type { RunnerDeps } from './deps.js';
import { RunnerRouteError } from './routing.js';
import type { DeployRequestPair } from './store.js';
import { runnerSettings } from './vocabulary.js';

/** A fresh grant or session token. */
export function mintDeployToken(prefix: typeof DEPLOY_GRANT_PREFIX | typeof DEPLOY_SESSION_PREFIX): string {
  return `${prefix}${randomBytes(DEPLOY_TOKEN_RANDOM_BYTES).toString('base64url')}`;
}

/** The stored form of a token: sha256, hex. */
export function hashDeployToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two stored hashes (hex of equal length; anything else is unequal). */
export function sameHash(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The statuses a deploy's job can be talking to the platform in: delivered but
 * not yet answered (`delivering`, or `queued` again after a lost answer — the
 * grant only ever left in a signed delivery, so its job may be running), or
 * accepted and running.
 */
const LIVE_STATUSES: readonly RunRequestStatus[] = [...PENDING_RUN_REQUEST_STATUSES, ...IN_PROGRESS_RUN_REQUEST_STATUSES];

/** 401 DEPLOY_GRANT_INVALID with its reason. */
export function grantInvalid(reason: DeployGrantRejectionReason): RunnerRouteError {
  const message = reason === 'expired'
    ? 'The deploy grant expired before the job exchanged it (the build waited too long in the queue). Deploy again.'
    : 'The deploy grant or session is not valid for this request.';
  return new RunnerRouteError('DEPLOY_GRANT_INVALID', message, { reason });
}

/** Load a deploy request with its deploy half (null for anything that is not one). */
export async function loadDeploy(deps: RunnerDeps, requestId: string): Promise<DeployRequestPair | null> {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
  const [request, deploy] = await Promise.all([deps.store.getRequest(requestId), deps.store.getDeploy(requestId)]);
  if (!request || !deploy || (request.action !== 'deploy' && request.action !== 'undeploy')) return null;
  return { request, deploy };
}

/**
 * Trade a grant for a session (`POST …/deploys/:requestId/session`). Throws
 * {@link grantInvalid}. The grant's encrypted copy is wiped; the session lives
 * to the deploy deadline (or, before the runner's answer was recorded, the
 * deadline it will get).
 */
export async function exchangeDeployGrant(deps: RunnerDeps, requestId: string, grant: unknown): Promise<DeploySessionDto> {
  const reject = (reason: DeployGrantRejectionReason, pair?: DeployRequestPair): never => {
    deps.metrics.inc(RUNNER_DEPLOY_METRICS.grantRejections, { reason });
    if (reason === 'reused' && pair) {
      deps.audit({
        action: 'pipeline.deploy.grant_reuse',
        actorId: SYSTEM_ACTOR_ID,
        orgId: pair.request.orgId,
        targetType: 'pipeline',
        targetId: pair.request.pipelineId,
        outcome: 'failure',
        details: { requestId: pair.request.id, runnerId: pair.request.runnerId, stage: pair.deploy.stage },
      });
    }
    throw grantInvalid(reason);
  };
  if (typeof grant !== 'string' || !DEPLOY_GRANT_PATTERN.test(grant)) return reject('unknown');
  const pair = await loadDeploy(deps, requestId);
  const hash = hashDeployToken(grant);
  if (!pair || !pair.deploy.grantHash || !sameHash(pair.deploy.grantHash, hash)) return reject('unknown');
  if (pair.deploy.grantUsedAt) return reject('reused', pair);
  const now = deps.now();
  if (pair.deploy.grantExpiresAt.getTime() <= now) {
    // Recorded so the dashboard can say why at once; the poll still decides the final status.
    await deps.store.updateDeploy(requestId, { resultCode: 'DEPLOY_GRANT_EXPIRED' }, { onlyIfUnfinished: true }).catch(() => null);
    return reject('expired');
  }
  if (!LIVE_STATUSES.includes(pair.request.status) || pair.deploy.finishedAt) return reject('wrong_state');

  const session = mintDeployToken(DEPLOY_SESSION_PREFIX);
  const expiresAt = pair.deploy.deadlineAt ?? new Date(now + runnerSettings().deployDeadlineMs);
  const claimed = await deps.store.claimGrant(requestId, hash, {
    grantUsedAt: new Date(now),
    grantEnc: null,
    sessionHash: hashDeployToken(session),
    sessionExpiresAt: expiresAt,
    stage: 'authenticating',
  });
  // Lost a race with a concurrent exchange of the same grant: that IS a reuse.
  if (!claimed) return reject('reused', pair);
  return {
    sessionToken: session,
    expiresAt: expiresAt.toISOString(),
    requestId,
    pipelineId: pair.request.pipelineId,
    region: claimed.region,
    pipelineName: claimed.pipelineName,
    stackName: claimed.stackName,
    toolchainRelease: claimed.toolchainRelease,
    protocol: DEPLOY_JOB_PROTOCOL_VERSION,
  };
}

/**
 * The deploy request a facade call's session token belongs to. The token must
 * be the one issued for THIS request id, unexpired, and the request still
 * running (delivered or accepted, not finished). Throws {@link grantInvalid}.
 */
export async function authenticateDeploySession(deps: RunnerDeps, requestId: string, authorization: string | undefined): Promise<DeployRequestPair> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1] ?? '';
  if (!DEPLOY_SESSION_PATTERN.test(token)) throw grantInvalid('unknown');
  const pair = await loadDeploy(deps, requestId);
  if (!pair || !sameHash(pair.deploy.sessionHash, hashDeployToken(token))) throw grantInvalid('unknown');
  if (!pair.deploy.sessionExpiresAt || pair.deploy.sessionExpiresAt.getTime() <= deps.now()) throw grantInvalid('expired');
  if (!LIVE_STATUSES.includes(pair.request.status) || pair.deploy.finishedAt) throw grantInvalid('wrong_state');
  return pair;
}

/** Whether a request is still before the runner's answer (the grant may be re-signed). */
export function isUndelivered(status: RunRequestStatus): boolean {
  return (PENDING_RUN_REQUEST_STATUSES as readonly string[]).includes(status);
}
