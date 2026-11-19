// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-request status read (`GET /pipelines/:id/run-requests/:requestId`),
 * which the console polls while a Re-run / Stop is queued.
 *
 * - Served from a 2 s per-request cache: a tab polling every second costs one
 *   row read per 2 s, not one per poll.
 * - Once a start has an execution id, its `executionStatus` is refreshed with a
 *   read-only signed `status` request to the runner (GetPipelineExecution in
 *   the customer account) at most every 15 s — the console's run state when no
 *   CodePipeline events reach the platform (no events stack in that region).
 *   Never once the execution is final, and never while the runner is unreachable.
 *   A refusal (e.g. 404 PIPELINE_NOT_FOUND after the pipeline moved) only leaves
 *   the status unknown: a read never fails the start, clears the link or touches
 *   health — the next start/stop through the link runs G4 re-discovery.
 */

import { isTerminalExecutionStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import { STATUS_READ_CACHE_MS, STATUS_REFRESH_MS } from './vocabulary.js';

export interface RunRequestDto {
  requestId: string;
  status: string;
  action: string;
  runnerLabel: string | null;
  executionId: string | null;
  /** The execution's CodePipeline status as the runner last reported it (start requests). */
  executionStatus: string | null;
  errorCode: string | null;
  attempts: number;
  requestedAt: string | null;
  expiresAt: string;
}

const readCache = new Map<string, { at: number; dto: RunRequestDto }>();
const statusCache = new Map<string, { at: number; executionStatus: string | null }>();
const MAX_CACHE = 5_000;

/** Forget both caches (tests). */
export function resetRunRequestCachesForTesting(): void {
  readCache.clear();
  statusCache.clear();
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  if (map.size >= MAX_CACHE) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

/** The DTO for one of the org's requests on `pipelineId`, or null (another org's is indistinguishable from none). */
export async function readRunRequest(deps: RunnerDeps, orgId: string, pipelineId: string, requestId: string): Promise<RunRequestDto | null> {
  const key = `${orgId}:${pipelineId.toLowerCase()}:${requestId}`;
  const now = deps.now();
  const hit = readCache.get(key);
  if (hit && now - hit.at < STATUS_READ_CACHE_MS && hit.dto.requestId === requestId) return hit.dto;

  const row = await deps.store.getRequest(requestId);
  if (!row || row.orgId !== orgId || row.pipelineId.toLowerCase() !== pipelineId.toLowerCase()) return null;
  const runner = row.runnerId ? await deps.store.getRunner(row.runnerId) : null;
  const executionId = row.resultExecutionId ?? (row.action === 'stop' ? row.executionId : null) ?? null;

  let executionStatus: string | null = null;
  if (row.action === 'start' && row.status === 'started' && executionId && runner && runner.status === 'active' && runner.functionUrl) {
    const cached = statusCache.get(key);
    // No call when the answer cannot change (a final state) or cannot come (an
    // unreachable runner would hold this read for the whole delivery timeout).
    if ((cached && (now - cached.at < STATUS_REFRESH_MS || isTerminalExecutionStatus(cached.executionStatus))) || runner.health !== 'healthy') {
      executionStatus = cached?.executionStatus ?? null;
    } else {
      const verdict = await deliverPush(deps, runner, {
        runnerId: runner.id, requestId: deps.newId(), action: 'status', pipelineId: row.pipelineId, executionId, requestedBy: row.requestedBy,
      });
      executionStatus = verdict.kind === 'success' ? verdict.executionStatus ?? null : cached?.executionStatus ?? null;
      remember(statusCache, key, { at: now, executionStatus });
    }
  }

  const dto: RunRequestDto = {
    requestId: row.id,
    status: row.status,
    action: row.action,
    runnerLabel: runner?.label ?? null,
    executionId,
    executionStatus,
    errorCode: row.errorCode ?? null,
    attempts: row.attempts,
    requestedAt: row.requestedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
  remember(readCache, key, { at: now, dto });
  return dto;
}
