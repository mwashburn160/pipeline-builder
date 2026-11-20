// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { QueuedRunRequestDto } from '@pipeline-builder/api-core/pipeline-runners';
import { routeExecution } from '../runners/execution-routing.js';
import { asRunnerRouteError, type QueuedRun } from '../runners/routing.js';
import { executionIdempotency } from '../services/execution-idempotency.js';

/** What a caller refused by the window is told — the same words on every start path. */
export const DUPLICATE_TRIGGER_MESSAGE = 'A pipeline execution was just triggered; please wait a moment before retrying';

/** The outcome of a windowed trigger: the start was queued for a runner, or one already was in-window. */
export type WindowedTrigger = { status: 'queued'; run: QueuedRun } | { status: 'duplicate' };

/** The one answer of Run, Stop and plugin-upgrade's redeploy (nothing else rides along). */
export function queuedRunRequestDto(run: Pick<QueuedRun, 'requestId' | 'status' | 'runnerLabel'>): QueuedRunRequestDto {
  return { requestId: run.requestId, status: run.status, runnerLabel: run.runnerLabel };
}

/** Who asked (`requestedBy` of the signed request) and where the org sits (for inherited runners). */
export interface TriggerOptions {
  /** A platform user id, or `system:plugin-upgrade`. */
  requestedBy?: string;
  /** The caller's parent org (a team inherits its ancestors' shared runners). */
  parentOrgId?: string;
}

/**
 * Queue a start of the pipeline through its runner under the per-(org,
 * pipeline) duplicate window — the ONE way every path in this service starts a
 * run, so a manual trigger and a plugin-upgrade redeploy of the same pipeline
 * (or a double click) queue one run.
 *
 * `duplicate` when a trigger already claimed the window. A runner refusal (no
 * runner, ambiguous, not found, unreachable, rate limited, paused) definitely
 * queued nothing, so it reopens the window before re-throwing. An unexpected
 * error keeps the window: the request row may have landed.
 */
export async function triggerExecutionInWindow(pipelineId: string, orgId: string, opts: TriggerOptions = {}): Promise<WindowedTrigger> {
  // The window keys on the id string while the lookups behind the start are
  // case-insensitive (a uuid): `ABC…` and `abc…` are one pipeline, one window.
  const windowId = pipelineId.toLowerCase();
  const claim = await executionIdempotency.claim(orgId, windowId);
  if (!claim) return { status: 'duplicate' };
  try {
    const run = await routeExecution({
      pipelineId, orgId, action: 'start', requestedBy: opts.requestedBy ?? 'unknown', ...(opts.parentOrgId ? { parentOrgId: opts.parentOrgId } : {}),
    });
    return { status: 'queued', run };
  } catch (err) {
    if (asRunnerRouteError(err)) await executionIdempotency.release(orgId, windowId, claim);
    throw err;
  }
}
