// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RegisterRunnersDto } from '@pipeline-builder/api-core/pipeline-runners';
import type { ApiClient } from './api-client.js';
import { unwrapData } from './response-utils.js';

type RegisterRunner = RegisterRunnersDto['runners'][number];

/** A runner's name as `pipeline register` prints it (a parent org's shared runner names that org). */
function runnerName(r: RegisterRunner): string {
  return !r.isOwn && r.ownerOrgName ? `${r.label} (shared by ${r.ownerOrgName})` : r.label;
}

/**
 * The runner `--runner <id or label>` names, among the ones the pipeline can be
 * registered with — the same list the dashboard's Register deployment dialog
 * offers. An id matches exactly; a label matches case-insensitively and must be
 * unique (an own runner and a parent's shared one can share a label: pass the
 * id). An unreachable runner is refused: its link probe would fail.
 */
export function pickRegisterRunner(facts: Pick<RegisterRunnersDto, 'available' | 'unavailableReason' | 'runners'>, wanted: string): RegisterRunner {
  if (!facts.available) {
    throw new Error(`No pipeline runner can link it right now (${facts.unavailableReason ?? 'paused'}). Register it without --runner; a runner links it once runners are back.`);
  }
  const key = wanted.trim().toLowerCase();
  const byId = facts.runners.find((r) => r.id.toLowerCase() === key);
  const matches = byId ? [byId] : facts.runners.filter((r) => r.label.toLowerCase() === key);
  if (matches.length === 0) {
    const known = facts.runners.map(runnerName);
    throw new Error(`No pipeline runner "${wanted}" can register this pipeline. ${known.length ? `Choose one of: ${known.join(', ')}.` : 'Your organization has no pipeline runner.'}`);
  }
  if (matches.length > 1) {
    throw new Error(`"${wanted}" names more than one pipeline runner (${matches.map((r) => `${runnerName(r)}: ${r.id}`).join('; ')}). Pass its id.`);
  }
  const runner = matches[0]!;
  if (runner.health !== 'healthy') {
    throw new Error(`The pipeline runner ${runnerName(runner)} is unreachable. Register it without --runner, or once the runner answers again.`);
  }
  return runner;
}

/** Read the runners a pipeline can be registered with (`GET /pipelines/:id/register-runners`) and pick `wanted`. */
export async function resolveRegisterRunner(client: Pick<ApiClient, 'get'>, pipelineUrl: string, pipelineId: string, wanted: string): Promise<RegisterRunner> {
  const res = await client.get<unknown>(`${pipelineUrl}/${encodeURIComponent(pipelineId)}/register-runners`);
  return pickRegisterRunner(unwrapData<RegisterRunnersDto>(res), wanted);
}
