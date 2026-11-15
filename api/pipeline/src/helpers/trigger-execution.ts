// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '@pipeline-builder/api-core';
import { executionIdempotency } from '../services/execution-idempotency.js';
import {
  pipelineExecutionService,
  PE_AWS_PIPELINE_NOT_FOUND,
  PE_PIPELINE_NOT_REGISTERED,
} from '../services/pipeline-execution-service.js';

/** What a caller refused by the window is told — the same words on every start path. */
export const DUPLICATE_TRIGGER_MESSAGE = 'A pipeline execution was just triggered; please wait a moment before retrying';

/** The outcome of a windowed trigger: a run started, or one already did in-window. */
export type WindowedTrigger =
  | { status: 'started'; executionId: string }
  | { status: 'duplicate' };

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
export async function triggerExecutionInWindow(pipelineId: string, orgId: string): Promise<WindowedTrigger> {
  // The window keys on the id string while the lookups behind the start are
  // case-insensitive (a uuid): `ABC…` and `abc…` are one pipeline, one window.
  const windowId = pipelineId.toLowerCase();
  const claim = await executionIdempotency.claim(orgId, windowId);
  if (!claim) return { status: 'duplicate' };
  try {
    const { executionId } = await pipelineExecutionService.triggerExecution(pipelineId, orgId);
    return { status: 'started', executionId };
  } catch (err) {
    const code = errorMessage(err);
    if (code === PE_PIPELINE_NOT_REGISTERED || code === PE_AWS_PIPELINE_NOT_FOUND) {
      await executionIdempotency.release(orgId, windowId, claim);
    }
    throw err;
  }
}
