// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Org-admin operations on runners: list (own + inherited), register (validate
 * the URL, then a signed ping that must answer `pong`), update (re-ping on a new
 * URL), test (ping; resumes delivery when it answers) and revoke (stop delivery,
 * clear pipeline links, expire pending requests).
 *
 * The Function URL is returned only to the OWNING org's admins and never
 * reaches a log or an audit row.
 */

import { runnerJwksPath } from '@pipeline-builder/api-core/pipeline-runners';
import { deliverPush, verdictCode } from './delivery.js';
import type { RunnerDeps } from './deps.js';
import { finishRequest, notifyUpdateRequired, recordRunnerFailure, recordRunnerSuccess, versionPatch } from './lifecycle.js';
import { eligibleRunners, RunnerRouteError } from './routing.js';
import type { RunnerRow } from './store.js';
import { checkFunctionUrl } from './url-policy.js';
import { MAX_RUNNERS_PER_ORG, PENDING_STATUSES, runnerSettings, versionBelow } from './vocabulary.js';

/** The runner as the API returns it. */
export interface RunnerDto {
  id: string;
  orgId: string;
  label: string;
  functionUrl: string | null;
  shareWithTeams: boolean;
  version: string | null;
  regions: string[];
  health: string;
  status: string;
  lastDeliveryAt: string | null;
  createdAt: string | null;
  /** Below MIN_RUNNER_VERSION: re-run setup-runner (refused after the grace period). */
  updateRequired: boolean;
  /** This runner's own JWKS (absolute: PLATFORM_BASE_URL + its per-runner path). */
  jwksUrl: string;
  /** Pipelines linked to this runner (`pipeline_registry.runner_id`); 0 outside the list. */
  pipelineCount: number;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A runner's public JWKS URL: PLATFORM_BASE_URL + `runnerJwksPath(id)`. */
export function runnerJwksUrl(runnerId: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PLATFORM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return `${base}${runnerJwksPath(runnerId)}`;
}

export function runnerDto(row: RunnerRow, viewerOrgId: string, pipelineCount = 0): RunnerDto {
  return {
    id: row.id,
    orgId: row.orgId,
    label: row.label,
    // Own org's admins only — an inherited runner's URL is its owner's secret.
    functionUrl: row.orgId === viewerOrgId ? row.functionUrl : null,
    shareWithTeams: row.shareWithTeams,
    version: row.version ?? null,
    regions: row.regions ?? [],
    health: row.health,
    status: row.status,
    lastDeliveryAt: iso(row.lastDeliveryAt),
    createdAt: iso(row.createdAt),
    updateRequired: versionBelow(row.version, runnerSettings().minRunnerVersion),
    jwksUrl: runnerJwksUrl(row.id),
    pipelineCount,
  };
}

export async function listRunners(deps: RunnerDeps, orgId: string, parentOrgId?: string) {
  const own = await deps.store.listRunners([orgId]);
  const inheritedRows = (await eligibleRunners(deps, orgId, parentOrgId)).filter((e) => e.depth > 0);
  const names = inheritedRows.length > 0 ? await deps.hierarchy.names([...new Set(inheritedRows.map((e) => e.runner.orgId))]) : {};
  const counts = await deps.store.pipelineCounts([...own.map((r) => r.id), ...inheritedRows.map((e) => e.runner.id)]);
  return {
    own: own.map((r) => runnerDto(r, orgId, counts.get(r.id) ?? 0)),
    inherited: inheritedRows.map((e) => ({
      ...runnerDto(e.runner, orgId, counts.get(e.runner.id) ?? 0),
      fromOrgId: e.runner.orgId,
      fromOrgName: names[e.runner.orgId.toLowerCase()] ?? e.runner.orgId,
    })),
  };
}

/** Ping a (possibly not yet stored) runner; refuses unless it answers `pong`. */
async function requirePong(deps: RunnerDeps, runner: RunnerRow, requestedBy: string) {
  const verdict = await deliverPush(deps, runner, { runnerId: runner.id, requestId: deps.newId(), action: 'ping', requestedBy });
  if (verdict.kind !== 'success') {
    throw new RunnerRouteError('RUNNER_PING_FAILED', `The runner did not answer the signed ping (${verdictCode(verdict)}). Check that it is deployed and its RUNNER_ID is ${runner.id}.`, { runnerLabel: runner.label });
  }
  return verdict;
}

export interface RegisterInput { label: string; functionUrl?: string; regions?: string[] }

/**
 * Register a runner. Register-then-deploy: without a URL the runner is created
 * `pending` (its id goes into the stack as RUNNER_ID; the PATCH that sets the
 * URL pings it and activates it). With a URL it is pinged now (aud = its new
 * id) and created `active` only after a pong.
 */
export async function registerRunner(deps: RunnerDeps, orgId: string, userId: string, input: RegisterInput): Promise<RunnerRow> {
  const url = input.functionUrl === undefined ? null : checkFunctionUrl(input.functionUrl);
  if (url && !url.ok) throw new RunnerRouteError('VALIDATION_ERROR', url.error);
  if ((await deps.store.countRunners(orgId)) >= MAX_RUNNERS_PER_ORG) {
    throw new RunnerRouteError('RUNNER_LIMIT', `An organization can register at most ${MAX_RUNNERS_PER_ORG} pipeline runners.`);
  }
  const now = new Date(deps.now());
  const draft: RunnerRow = {
    id: deps.newId(),
    orgId,
    label: input.label,
    functionUrl: url?.ok ? url.url : null,
    shareWithTeams: true,
    version: null,
    regions: input.regions ?? [],
    health: 'healthy',
    status: url ? 'active' : 'pending',
    consecutiveFailures: 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    lastDeliveryAt: null,
    updateRequiredSince: null,
  };
  if (!url) return deps.store.insertRunner(draft);
  const pong = await requirePong(deps, draft, userId);
  // The same MIN_RUNNER_VERSION bookkeeping a dispatcher ping applies.
  const version = versionPatch(draft, pong.runnerVersion, new Date(deps.now()));
  const stored = await deps.store.insertRunner({
    ...draft,
    version: pong.runnerVersion ?? null,
    regions: input.regions ?? pong.regions ?? [],
    lastDeliveryAt: new Date(deps.now()),
    ...version.patch,
  });
  if (version.flagged) await notifyUpdateRequired(deps, stored, pong.runnerVersion!);
  return stored;
}

/** The caller's OWN runner (inherited and other orgs' runners are not found). */
export async function ownRunner(deps: RunnerDeps, orgId: string, id: string): Promise<RunnerRow> {
  const runner = /^[0-9a-f-]{36}$/i.test(id) ? await deps.store.getRunner(id) : null;
  if (!runner || runner.orgId !== orgId) throw new RunnerRouteError('NOT_FOUND', 'Pipeline runner not found.');
  return runner;
}

/** The caller's own runner, refused 409 RUNNER_REVOKED once revoked (only listing and revoke accept one). */
async function ownLiveRunner(deps: RunnerDeps, orgId: string, id: string): Promise<RunnerRow> {
  const runner = await ownRunner(deps, orgId, id);
  if (runner.status === 'revoked') throw new RunnerRouteError('RUNNER_REVOKED', 'This pipeline runner was revoked.', { runnerLabel: runner.label });
  return runner;
}

export interface UpdateInput { label?: string; shareWithTeams?: boolean; functionUrl?: string }

export async function updateRunner(deps: RunnerDeps, orgId: string, userId: string, id: string, input: UpdateInput): Promise<{ runner: RunnerRow; changed: string[] }> {
  const runner = await ownLiveRunner(deps, orgId, id);
  const patch: Partial<RunnerRow> = {};
  const changed: string[] = [];
  let flaggedVersion: string | undefined;
  if (input.label !== undefined && input.label !== runner.label) { patch.label = input.label; changed.push('label'); }
  if (input.shareWithTeams !== undefined && input.shareWithTeams !== runner.shareWithTeams) { patch.shareWithTeams = input.shareWithTeams; changed.push('shareWithTeams'); }
  if (input.functionUrl !== undefined) {
    const url = checkFunctionUrl(input.functionUrl);
    if (!url.ok) throw new RunnerRouteError('VALIDATION_ERROR', url.error);
    if (url.url !== runner.functionUrl || runner.status === 'pending') {
      // The deployed stack's ping (aud = this runner's id): a pending runner becomes active.
      const pong = await requirePong(deps, { ...runner, functionUrl: url.url }, userId);
      const version = versionPatch(runner, pong.runnerVersion, new Date(deps.now()));
      if (version.flagged) flaggedVersion = pong.runnerVersion;
      Object.assign(patch, version.patch, {
        functionUrl: url.url,
        health: 'healthy',
        consecutiveFailures: 0,
        lastDeliveryAt: new Date(deps.now()),
        ...(pong.runnerVersion ? { version: pong.runnerVersion } : {}),
        ...(pong.regions && runner.regions.length === 0 ? { regions: pong.regions } : {}),
        ...(runner.status === 'pending' ? { status: 'active' } : {}),
      });
      changed.push('functionUrl');
      if (runner.status === 'pending') changed.push('status');
    }
  }
  if (changed.length === 0) return { runner, changed };
  // Un-sharing needs no link cleanup: a team's pipeline linked to this runner
  // no longer finds it eligible, so its next run goes through discovery.
  const updated = (await deps.store.updateRunner(runner.id, patch)) ?? runner;
  if (flaggedVersion) await notifyUpdateRequired(deps, updated, flaggedVersion);
  return { runner: updated, changed };
}

export async function testRunner(deps: RunnerDeps, orgId: string, userId: string, id: string): Promise<{ ok: boolean; outcome?: string; errorCode?: string }> {
  const runner = await ownLiveRunner(deps, orgId, id);
  if (runner.status === 'pending' || !runner.functionUrl) {
    throw new RunnerRouteError('RUNNER_PENDING', 'This pipeline runner has no URL yet: deploy its stack, then set its Function URL.', { runnerLabel: runner.label });
  }
  const verdict = await deliverPush(deps, runner, { runnerId: runner.id, requestId: deps.newId(), action: 'ping', requestedBy: userId });
  if (verdict.kind === 'success') {
    // Healthy again: paused requests resume.
    await recordRunnerSuccess(deps, runner, verdict);
    return { ok: true, outcome: verdict.outcome };
  }
  if (verdict.kind === 'retry' && verdict.transport) await recordRunnerFailure(deps, runner, verdict.immediate);
  return { ok: false, errorCode: verdictCode(verdict) };
}

export async function revokeRunner(deps: RunnerDeps, orgId: string, id: string): Promise<{ runner: RunnerRow; linksCleared: number; requestsExpired: number }> {
  const runner = await ownRunner(deps, orgId, id);
  const revoked = runner.status === 'revoked' ? runner : ((await deps.store.updateRunner(runner.id, { status: 'revoked' })) ?? runner);
  const linksCleared = await deps.store.clearRunnerLinks(runner.id);
  let requestsExpired = 0;
  for (const r of await deps.store.listRunnerRequests(runner.id, PENDING_STATUSES)) {
    if (await finishRequest(deps, r, 'expired', { errorCode: 'RUNNER_REVOKED' })) requestsExpired++;
  }
  return { runner: revoked, linksCleared, requestsExpired };
}
