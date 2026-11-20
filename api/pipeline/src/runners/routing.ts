// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which runner a start/stop for pipeline P in org O goes through. Runners are
 * the ONLY execution path: the platform never has pipelines in its own AWS
 * account.
 *
 *  1. The registry links P to a runner that is ELIGIBLE (O's own, or an
 *     ancestor's shared with teams; active) → enqueue for it — or refuse with
 *     409 RUNNER_UNREACHABLE when it is unhealthy (never a silent queue).
 *  2. Otherwise discovery: O's eligible runners are probed in parallel (signed
 *     `probe`). The NEAREST level that matches wins (0 = O's own runners, 1 =
 *     the parent's shared ones, …): exactly one match at that level links P to
 *     it and enqueues; two at the same level → 409 AMBIGUOUS_RUNNER; none at
 *     any level → 404 PIPELINE_NOT_FOUND_IN_RUNNERS; O has no runner → 409
 *     NO_RUNNER (the expected first-run state).
 *
 * Every probe (discovery, rediscovery, the background probe at registration
 * and Find runner again) records its state and outcome on the registry row
 * (`runner_link_status`, `_checked_at`, `_detail` — runner labels only).
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import {
  isRunnerErrorCode, runnerErrorStatus, type PendingRunRequestStatus, type RunnerApiErrorCode, type RunnerErrorCode, type RunnerLinkDetail, type RunnerLinkStatus, type RunnerReplyErrorCode,
} from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import { recordRunnerFailure, recordRunnerSuccess, updateGraceExpired } from './lifecycle.js';
import type { RegistryLink, RunRequestRow, RunnerRow } from './store.js';
import { isSystemRequester, RUN_REQUEST_TTL_MS, runnerSettings } from './vocabulary.js';

const logger = createLogger('runner-routing');

/** The generic (non-runner) codes a runner admin path also refuses with, and their HTTP status. */
const GENERIC_ROUTE_STATUS = { VALIDATION_ERROR: 400, NOT_FOUND: 404 } as const;

/** What a runner path refuses with: a runner catalog code, or one of the generic two. */
export type RunnerRouteCode = RunnerApiErrorCode | RunnerReplyErrorCode | keyof typeof GENERIC_ROUTE_STATUS;

/** A runner-path refusal: the error-envelope `code` (its HTTP status from the shared catalog), optional UI details. */
export class RunnerRouteError extends Error {
  readonly status: number;

  constructor(
    readonly code: RunnerRouteCode,
    message: string,
    readonly details?: { runnerLabel?: string; lastDeliveryAt?: string | null; runnersChecked?: string[] },
  ) {
    super(message);
    this.name = 'RunnerRouteError';
    this.status = code in GENERIC_ROUTE_STATUS
      ? GENERIC_ROUTE_STATUS[code as keyof typeof GENERIC_ROUTE_STATUS]
      : runnerErrorStatus(code as RunnerApiErrorCode | RunnerReplyErrorCode);
  }
}

/**
 * A runner-catalog refusal thrown from outside this module (the signer's
 * RUNNER_KEY_MISSING / RUNNER_KEY_UNREADABLE) as a {@link RunnerRouteError}, so
 * every route answers it with the catalog status; anything else → null.
 */
export function asRunnerRouteError(err: unknown): RunnerRouteError | null {
  if (err instanceof RunnerRouteError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !isRunnerErrorCode(code)) return null;
  const mapped = new RunnerRouteError(code as RunnerRouteCode, err instanceof Error ? err.message : code);
  return typeof mapped.status === 'number' ? mapped : null;
}

/** A runner as routing sees it: the row plus the org it is inherited from (if any). */
export interface EligibleRunner {
  runner: RunnerRow;
  /** Distance up the hierarchy: 0 = own org, 1 = direct parent, … */
  depth: number;
}

/**
 * The runners org `orgId` may use, in routing order: its own active runners,
 * then each ancestor's active runners shared with teams, nearest first.
 */
export async function eligibleRunners(deps: RunnerDeps, orgId: string, parentOrgId?: string): Promise<EligibleRunner[]> {
  const ancestors = await deps.hierarchy.ancestors(orgId, parentOrgId);
  const rows = await deps.store.listRunners([orgId, ...ancestors], { activeOnly: true });
  const out: EligibleRunner[] = [];
  const own = rows.filter((r) => r.orgId === orgId);
  for (const r of own) out.push({ runner: r, depth: 0 });
  ancestors.forEach((a, i) => {
    for (const r of rows) if (r.orgId === a && r.shareWithTeams) out.push({ runner: r, depth: i + 1 });
  });
  return out;
}

/** Whether `runner` is usable by `orgId` given its eligible set. */
function isEligible(runner: RunnerRow | null, eligible: EligibleRunner[]): runner is RunnerRow {
  return !!runner && eligible.some((e) => e.runner.id === runner.id);
}

function unhealthy(runner: RunnerRow): RunnerRouteError {
  return new RunnerRouteError('RUNNER_UNREACHABLE', `Pipeline runner "${runner.label}" is unreachable; runs through it are paused until it answers again.`, {
    runnerLabel: runner.label,
    lastDeliveryAt: runner.lastDeliveryAt ? runner.lastDeliveryAt.toISOString() : null,
  });
}

export interface RouteInput {
  pipelineId: string;
  orgId: string;
  parentOrgId?: string;
  requestedBy: string;
  action: 'start' | 'stop';
  executionId?: string;
}

/** The queued answer of a runner-routed start/stop (`delivering` when an in-flight start was reused). */
export interface QueuedRun {
  requestId: string;
  status: PendingRunRequestStatus;
  runnerLabel: string;
  runnerId: string;
  /** An already-pending start of the same pipeline was returned instead of a new one (G12). */
  reused: boolean;
}

/** A Postgres unique violation (drizzle wraps the driver error as `cause`). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** A below-minimum runner past its upgrade grace is refused. */
function assertUpToDate(deps: RunnerDeps, runner: RunnerRow): void {
  if (updateGraceExpired(runner, deps.now())) {
    throw new RunnerRouteError('RUNNER_UPDATE_REQUIRED', `Pipeline runner "${runner.label}" runs an unsupported version (${runner.version}); update it with pipeline-manager infra setup-runner.`, { runnerLabel: runner.label });
  }
}

/**
 * Record + enqueue one start/stop for a runner. A START while another start of
 * the same pipeline is still pending returns that one (no second run); then the
 * org's pending cap (MAX_PENDING_PER_ORG) and the per-(org, pipeline) rate limit
 * (RUN_REQUESTS_PER_MINUTE) apply to USER requests. A system-initiated request
 * (a plugin-upgrade redeploy fan-out) waits in the queue past both instead.
 */
export async function enqueueRun(deps: RunnerDeps, runner: RunnerRow, input: RouteInput, parentRequestId?: string): Promise<QueuedRun> {
  const reuse = async (): Promise<QueuedRun | null> => {
    const existing = await deps.store.findPendingStart(input.orgId, input.pipelineId);
    if (!existing) return null;
    const via = existing.runnerId === runner.id ? runner : (existing.runnerId ? await deps.store.getRunner(existing.runnerId) : null) ?? runner;
    return { requestId: existing.id, status: existing.status === 'delivering' ? 'delivering' : 'queued', runnerLabel: via.label, runnerId: via.id, reused: true };
  };
  if (input.action === 'start') {
    const existing = await reuse();
    if (existing) return existing;
  }
  assertUpToDate(deps, runner);
  if (!isSystemRequester(input.requestedBy)) {
    const { maxPendingPerOrg, runRequestsPerMinute } = runnerSettings();
    if ((await deps.store.countPending(input.orgId)) >= maxPendingPerOrg) {
      throw new RunnerRouteError('TOO_MANY_PENDING', `Your organization already has ${maxPendingPerOrg} runs waiting for a runner; wait for some to finish.`, { runnerLabel: runner.label });
    }
    const allowed = await deps.limiter.hit(`${input.orgId}:${input.pipelineId.toLowerCase()}`, runRequestsPerMinute, 60_000);
    if (!allowed) throw new RunnerRouteError('RUN_REQUEST_RATE_LIMITED', 'Too many runs requested for this pipeline; wait a minute and try again.', { runnerLabel: runner.label });
  }
  let row: RunRequestRow;
  try {
    row = await deps.store.insertRequest({
      id: deps.newId(),
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      action: input.action,
      executionId: input.executionId ?? null,
      parentRequestId: parentRequestId ?? null,
      requestedBy: input.requestedBy,
      requestedAt: new Date(deps.now()),
      expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
      status: 'queued',
      runnerId: runner.id,
    });
  } catch (err) {
    // The one-pending-start index: a concurrent Re-run inserted first — return its request.
    const winner = input.action === 'start' && isUniqueViolation(err) ? await reuse() : null;
    if (winner) return winner;
    throw err;
  }
  deps.metrics.inc('pipeline_runner_requests_total', { status: 'queued' });
  // The row is the durable state: a queue that is down (Redis unavailable)
  // leaves it `queued`, and the sweep enqueues it once the queue is back.
  await deps.queue.enqueue(row.id).catch((err: unknown) => {
    logger.warn('Runner dispatch enqueue failed; the sweep re-kicks the request', { requestId: row.id, error: errorMessage(err) });
  });
  return { requestId: row.id, status: 'queued', runnerLabel: runner.label, runnerId: runner.id, reused: false };
}

/** The linked runner when it is eligible — refused if unhealthy — else null. */
export async function linkedRunner(deps: RunnerDeps, link: RegistryLink | null, eligible: EligibleRunner[]): Promise<RunnerRow | null> {
  if (!link?.runnerId) return null;
  const runner = await deps.store.getRunner(link.runnerId);
  if (!isEligible(runner, eligible)) return null;
  if (runner.health !== 'healthy') throw unhealthy(runner);
  return runner;
}

/** The message NO_RUNNER answers with: the expected first-run state, pointing at the install. */
export const NO_RUNNER_MESSAGE = 'This pipeline needs a runner. Install one in the pipeline\'s AWS account (one per account per organization) from Settings → Pipeline runners, then run it again.';

/** One probe's verdict, by runner. */
interface ProbeResult { entry: EligibleRunner; matched: boolean; ambiguousPipeline: boolean }

/** Record a probe's state/outcome on the registry row (best effort: a failed write never fails routing). */
async function writeLink(deps: RunnerDeps, input: Pick<RouteInput, 'pipelineId' | 'orgId'>, status: RunnerLinkStatus, detail: RunnerLinkDetail | null, runnerId?: string): Promise<void> {
  await deps.store.writeRunnerLink(input.pipelineId, input.orgId, {
    status, checkedAt: new Date(deps.now()), detail, ...(runnerId ? { runnerId } : {}),
  }).catch((err: unknown) => {
    logger.warn('Recording the runner link failed', { pipelineId: input.pipelineId, error: errorMessage(err) });
  });
}

/** Probe one runner for the pipeline's tag, recording the probe as a `probe` request row. */
async function probe(deps: RunnerDeps, input: RouteInput, entry: EligibleRunner, link: RegistryLink | null, parentRequestId?: string): Promise<ProbeResult> {
  const { runner } = entry;
  const row: RunRequestRow = await deps.store.insertRequest({
    id: deps.newId(),
    orgId: input.orgId,
    pipelineId: input.pipelineId,
    action: 'probe',
    requestedBy: input.requestedBy,
    requestedAt: new Date(deps.now()),
    expiresAt: new Date(deps.now() + RUN_REQUEST_TTL_MS),
    status: 'delivering',
    attempts: 1,
    runnerId: runner.id,
    ...(parentRequestId ? { parentRequestId } : {}),
  });
  const hint = link?.region ? { region: link.region, pipelineName: link.pipelineName } : undefined;
  const verdict = await deliverPush(deps, runner, {
    runnerId: runner.id,
    requestId: row.id,
    action: 'probe',
    pipelineId: input.pipelineId,
    ...(hint ? { hint } : {}),
    requestedBy: input.requestedBy,
    expiresAt: row.expiresAt,
  });
  const matched = verdict.kind === 'success' && verdict.outcome === 'match';
  if (verdict.kind === 'success') await recordRunnerSuccess(deps, runner, verdict);
  else if (verdict.kind === 'retry' && verdict.transport) await recordRunnerFailure(deps, runner, verdict.immediate);
  await deps.store.updateRequest(row.id, matched
    ? { status: 'started' }
    : { status: 'failed', errorCode: verdict.kind === 'fail' ? verdict.code : verdict.kind === 'success' ? 'NO_MATCH' : 'RUNNER_UNREACHABLE' });
  return { entry, matched, ambiguousPipeline: verdict.kind === 'fail' && verdict.code === 'AMBIGUOUS_PIPELINE' };
}

/**
 * Discovery: probe every eligible healthy runner in parallel for the
 * pipeline's tag, then take the NEAREST level with an answer (group by depth:
 * 0 = own, 1 = parent, …). Exactly one match at that level → the pipeline is
 * linked to it (when it has a registry row) and returned; a runner there that
 * sees two pipelines with the tag → AMBIGUOUS_PIPELINE; two matches there →
 * AMBIGUOUS_RUNNER (a deeper level's matches are ignored once a nearer one
 * matched, so a team's own runner beats its parent's shared one in the same
 * account). The probes are recorded as `probe` rows so the trail shows which
 * runners were asked, and the outcome on the registry row.
 */
export async function discoverRunner(
  deps: RunnerDeps, input: RouteInput, eligible: EligibleRunner[], link: RegistryLink | null, parentRequestId?: string,
): Promise<RunnerRow> {
  const labels = eligible.map((e) => e.runner.label);
  const refuse = async (code: RunnerErrorCode & RunnerRouteCode, message: string, status: RunnerLinkStatus, matched: string[], details?: RunnerRouteError['details']): Promise<never> => {
    if (link) await writeLink(deps, input, status, { runnersChecked: labels, matched, errorCode: code });
    throw new RunnerRouteError(code, message, details);
  };
  if (eligible.length === 0) return refuse('NO_RUNNER', NO_RUNNER_MESSAGE, 'not_found', []);
  const healthy = eligible.filter((e) => e.runner.health === 'healthy');
  if (healthy.length === 0) {
    const down = unhealthy(eligible[0]!.runner);
    return refuse('RUNNER_UNREACHABLE', down.message, 'not_found', [], down.details);
  }
  if (link) await writeLink(deps, input, 'checking', link.linkDetail ?? null);

  let results: ProbeResult[];
  try {
    results = await Promise.all(healthy.map((e) => probe(deps, input, e, link, parentRequestId)));
  } catch (err) {
    // Never leave the row `checking`: put back what it said before this probe.
    const before = link?.linkStatus && link.linkStatus !== 'checking' ? link.linkStatus : (link?.runnerId ? 'linked' : 'unlinked');
    if (link) await writeLink(deps, input, before, link.linkDetail ?? null);
    throw err;
  }
  const depths = [...new Set(results.map((r) => r.entry.depth))].sort((a, b) => a - b);
  for (const depth of depths) {
    const level = results.filter((r) => r.entry.depth === depth);
    // A runner that sees MORE than one pipeline carrying this id cannot pick one.
    const ambiguous = level.filter((r) => r.ambiguousPipeline).map((r) => r.entry.runner.label);
    if (ambiguous.length > 0) {
      return refuse('AMBIGUOUS_PIPELINE', 'A pipeline runner found more than one pipeline tagged with this pipeline\'s id; remove the duplicate tag in that AWS account.', 'ambiguous', ambiguous, { runnersChecked: ambiguous });
    }
    const matches = level.filter((r) => r.matched).map((r) => r.entry.runner);
    if (matches.length > 1) {
      const names = matches.map((m) => m.label);
      return refuse('AMBIGUOUS_RUNNER', 'More than one pipeline runner found this pipeline. An organization has at most one runner per AWS account: revoke the runner that should not run it.', 'ambiguous', names, { runnersChecked: names });
    }
    if (matches.length === 1) {
      const runner = matches[0]!;
      // A single match IS the verification: link it (a pipeline without a registry row stays unlinked).
      if (link) await writeLink(deps, input, 'linked', { runnersChecked: labels, matched: [runner.label], errorCode: null }, runner.id);
      return runner;
    }
  }
  return refuse('PIPELINE_NOT_FOUND_IN_RUNNERS', 'No pipeline runner found this pipeline (by its pb.pipeline-id tag).', 'not_found', [], { runnersChecked: labels });
}

/**
 * The background probe (pipeline registration, and Find runner again): run
 * discovery for a pipeline and record the outcome on its registry row. Never
 * throws — every outcome, including a refusal, is the recorded status. A single
 * match replaces the link; anything else keeps the old `runner_id`.
 */
export async function probeRunnerLink(deps: RunnerDeps, input: Pick<RouteInput, 'pipelineId' | 'orgId' | 'parentOrgId' | 'requestedBy'>): Promise<RunnerLinkStatus> {
  try {
    const link = await deps.store.getRegistryLink(input.pipelineId, input.orgId);
    if (!link) return 'unlinked';
    const eligible = await eligibleRunners(deps, input.orgId, input.parentOrgId);
    await discoverRunner(deps, { ...input, action: 'start' }, eligible, link);
    return 'linked';
  } catch (err) {
    if (err instanceof RunnerRouteError) return err.code === 'AMBIGUOUS_RUNNER' || err.code === 'AMBIGUOUS_PIPELINE' ? 'ambiguous' : 'not_found';
    logger.warn('Background runner-link probe failed', { pipelineId: input.pipelineId, error: errorMessage(err) });
    return 'not_found';
  }
}

/**
 * The background probe at pipeline registration: when runners are available
 * and the pipeline is not already linked, probe and record the link. Resolves
 * to the recorded status (`linked` when it already was), never rejects.
 */
export async function linkInBackground(deps: RunnerDeps, input: Pick<RouteInput, 'pipelineId' | 'orgId' | 'parentOrgId' | 'requestedBy'>): Promise<RunnerLinkStatus | null> {
  try {
    if (!(await deps.runnersAvailable()).available) return null;
    const link = await deps.store.getRegistryLink(input.pipelineId, input.orgId);
    if (!link) return null;
    if (link.runnerId && link.linkStatus === 'linked') return 'linked';
    return await probeRunnerLink(deps, input);
  } catch (err) {
    logger.warn('Background runner linking failed', { pipelineId: input.pipelineId, error: errorMessage(err) });
    return null;
  }
}

/**
 * A linked runner answered PIPELINE_NOT_FOUND for a queued start/stop: the link
 * was already cleared; probe the org's OTHER eligible runners once (the probes
 * name the request as their parent, which is what makes it "once") and, on a
 * single match, re-target the SAME request — the caller keeps polling one id.
 * The dispatch job that asked delivers it again (nothing is enqueued here).
 */
export async function rediscoverRequest(deps: RunnerDeps, request: RunRequestRow, failed: RunnerRow): Promise<boolean> {
  if (await deps.store.hasChildRequests(request.id)) return false;
  const eligible = (await eligibleRunners(deps, request.orgId)).filter((e) => e.runner.id !== failed.id);
  if (eligible.length === 0) return false;
  const link = await deps.store.getRegistryLink(request.pipelineId, request.orgId);
  const input: RouteInput = {
    pipelineId: request.pipelineId,
    orgId: request.orgId,
    requestedBy: request.requestedBy,
    action: request.action === 'stop' ? 'stop' : 'start',
    ...(request.executionId ? { executionId: request.executionId } : {}),
  };
  let runner: RunnerRow;
  try {
    runner = await discoverRunner(deps, input, eligible, link, request.id);
  } catch {
    return false;
  }
  const moved = await deps.store.updateRequest(request.id, {
    runnerId: runner.id, status: 'queued', nextAttemptAt: null, lastDeliveryError: 'rediscovered',
  }, ['queued', 'delivering']);
  return !!moved;
}
