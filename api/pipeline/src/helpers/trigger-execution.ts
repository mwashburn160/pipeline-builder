// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '@pipeline-builder/api-core';
import type { PendingRunRequestStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { runnersAvailable } from '../runners/deps.js';
import { routeExecution } from '../runners/execution-routing.js';
import { RunnerRouteError } from '../runners/routing.js';
import { executionIdempotency } from '../services/execution-idempotency.js';
import {
  pipelineExecutionService,
  PE_AWS_PIPELINE_NOT_FOUND,
  PE_PIPELINE_NOT_REGISTERED,
} from '../services/pipeline-execution-service.js';

/** What a caller refused by the window is told — the same words on every start path. */
export const DUPLICATE_TRIGGER_MESSAGE = 'A pipeline execution was just triggered; please wait a moment before retrying';

/**
 * The outcome of a windowed trigger: a run started, one already did in-window,
 * or (cross-account runners) the start was queued for a runner.
 */
export type WindowedTrigger =
  | { status: 'started'; executionId: string }
  | { status: 'queued'; requestId: string; requestStatus: PendingRunRequestStatus; runnerLabel: string; runnerId: string; reused: boolean }
  | { status: 'duplicate' };

/** Who asked, for the runner path (`requestedBy` of the signed request). */
export interface TriggerOptions {
  /** A platform user id, or `system:plugin-upgrade`. */
  requestedBy?: string;
  /** The caller's parent org (a team inherits its ancestors' shared runners). */
  parentOrgId?: string;
  /** The caller's org holds `cross_account_runners` (its token's features). */
  orgHasFeature?: boolean;
}

/**
 * Start a CodePipeline execution under the per-(org, pipeline) duplicate window
 * — the ONE way every path in this service starts a run, so a manual trigger
 * and a plugin-upgrade redeploy of the same pipeline cannot launch two runs
 * seconds apart.
 *
 * `duplicate` when a trigger already claimed the window. A failed start
 * re-throws the {@link pipelineExecutionService} error unchanged, having
 * reopened the window ONLY when the run definitely never started (not
 * registered / not found in AWS). After an AWS error or a timeout the start may
 * have landed, and keeping the window is what stops a retry launching a
 * duplicate run.
 */
export async function triggerExecutionInWindow(pipelineId: string, orgId: string, opts: TriggerOptions = {}): Promise<WindowedTrigger> {
  // The window keys on the id string while the lookups behind the start are
  // case-insensitive (a uuid): `ABC…` and `abc…` are one pipeline, one window.
  const windowId = pipelineId.toLowerCase();
  const claim = await executionIdempotency.claim(orgId, windowId);
  if (!claim) return { status: 'duplicate' };
  try {
    if (!runnersAvailable()) {
      const { executionId } = await pipelineExecutionService.triggerExecution(pipelineId, orgId);
      return { status: 'started', executionId };
    }
    // Cross-account runners: a linked (or discovered) runner gets the start;
    // anything else is the platform-account call above, unchanged.
    const routed = await routeExecution(
      { pipelineId, orgId, action: 'start', requestedBy: opts.requestedBy ?? 'unknown', orgHasFeature: opts.orgHasFeature ?? false, ...(opts.parentOrgId ? { parentOrgId: opts.parentOrgId } : {}) },
      () => pipelineExecutionService.triggerExecution(pipelineId, orgId),
    );
    if (routed.kind === 'platform') return { status: 'started', executionId: routed.value.executionId };
    return { status: 'queued', requestId: routed.requestId, requestStatus: routed.status, runnerLabel: routed.runnerLabel, runnerId: routed.runnerId, reused: routed.reused };
  } catch (err) {
    const code = errorMessage(err);
    // A runner refusal (no runner, ambiguous, not found, unreachable, rate
    // limited) definitely started nothing: reopen the window like a not-found.
    if (code === PE_PIPELINE_NOT_REGISTERED || code === PE_AWS_PIPELINE_NOT_FOUND || err instanceof RunnerRouteError) {
      await executionIdempotency.release(orgId, windowId, claim);
    }
    throw err;
  }
}
