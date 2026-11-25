// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline runner routes.
 *
 * Public (mounted at /pipelines/runner, ahead of auth and the apiCalls meter):
 * - GET    /pipelines/runner/runners/:runnerId/jwks.json   the keys runner :runnerId trusts (its owner's effective key org).
 *
 * Org admin (org_settings:write; writes add MFA-grade + step-up):
 * - GET    /pipelines/runners                         own + inherited runners, signingKey status.
 * - POST   /pipelines/runners                         register (creates the org key on the first runner).
 * - PATCH  /pipelines/runners/:id                     rename / share / share deploys with teams / new URL.
 * - POST   /pipelines/runners/:id/test                signed ping, 5/min/org.
 * - DELETE /pipelines/runners/:id                     revoke.
 * - POST   /pipelines/runners/signing-key             generate the first key.
 * - POST   /pipelines/runners/signing-key/rotate      publish a next key; DELETE cancels it.
 * - POST   /pipelines/runners/signing-key/finish      retire the retiring key once its time has passed.
 * - POST   /pipelines/runners/signing-key/revoke      emergency revoke (typed confirmation).
 * - PUT    /pipelines/runners/signing-key/mode        inherit / own (sub-organizations).
 *   Every signing-key write is also limited to 5 per org per hour (failing closed when the
 *   limit store is down), and is allowed while deliveries are paused.
 *
 * Operators (system org):
 * - GET    /pipelines/admin/runner-signing-keys               orgs:read — key status of every org.
 * - POST   /pipelines/admin/orgs/:orgId/runner-signing-key/revoke   orgs:manage + step-up — revoke one org's key.
 * - GET    /pipelines/admin/runner-deliveries                 orgs:read — the pause toggle.
 * - PUT    /pipelines/admin/runner-deliveries                 orgs:manage + step-up — pause / resume every runner delivery.
 *
 * Internal (platform only): POST /pipelines/internal/runner-signing-keys/reencrypt.
 *
 * - GET    /pipelines/:pipelineId/run-requests/:requestId   pipelines:read — a queued run's progress.
 *
 * No response, log line or audit entry carries key material: only kids, states and dates.
 */

import {
  actorId,
  audited,
  contractRoute,
  ErrorCode,
  errorMessage,
  getParam,
  parseContractBody,
  PIPELINE_INTERNAL,
  recordAudit,
  requireAssurance,
  requireAuth,
  requireInternalService,
  requirePermission,
  requireStepUp,
  requireSystemOrgPermission,
  sendBadRequest,
  sendError,
  sendPaginatedNested,
  sendSuccess,
  SYSTEM_ORG_ID,
  validateBody,
} from '@pipeline-builder/api-core';
import {
  RUNNER_JWKS_CACHE_SECONDS,
  RUNNER_JWKS_IP_REQUESTS_PER_MINUTE,
  RUNNER_JWKS_REQUESTS_PER_MINUTE,
  RUNNER_KEY_MODES,
  RUNNER_KEY_ROTATION_STATES,
  RUNNER_KEY_WRITES_PER_HOUR,
  runnerErrorStatus,
  type RunnerDeliveriesDto,
  type RunnersUnavailableReason,
} from '@pipeline-builder/api-core/pipeline-runners';
import { createAuthenticatedWithOrgRoute, rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { listRunners, registerRunner, revokeRunner, runnerDto, runnerJwksUrl, testRunner, updateRunner } from '../runners/admin.js';

/** The absolute per-runner JWKS URL (admin.ts owns it). */
export { runnerJwksUrl };
import { runnerDeps, type RunnerDeps } from '../runners/deps.js';
import { reencryptRunnerKeys } from '../runners/key-reencrypt.js';
import {
  cancelOrgKeyRotation,
  ensureOrgKeyForFirstRunner,
  finishOrgKeyRotation,
  generateOrgKey,
  listKeyStatus,
  publicKeysForRunner,
  revokeOrgKey,
  rotateOrgKey,
  setOrgKeyMode,
  signingKeyDto,
  type KeyAuditAction,
} from '../runners/keys.js';
import { RunnerRouteError, RUNNERS_UNAVAILABLE_MESSAGES } from '../runners/routing.js';
import { readRunRequest } from '../runners/run-request-status.js';
import { runnerSettings } from '../runners/vocabulary.js';

const REGION = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'regions must be AWS region names');
const LABEL = z.string().trim().min(1, 'label is required').max(100);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_ID = /^[0-9a-f]{24}$/i;

const RegisterSchema = z.object({
  label: LABEL,
  // Omitted → a `pending` runner (register, then deploy the stack with its id, then PATCH the URL).
  functionUrl: z.string().min(1).max(2048).optional(),
  regions: z.array(REGION).max(30).optional(),
}).strict();

const UpdateSchema = z.object({
  label: LABEL.optional(),
  shareWithTeams: z.boolean().optional(),
  /** Teams this runner is shared with may also deploy through it (needs shareWithTeams; un-sharing turns it off). */
  shareDeploysWithTeams: z.boolean().optional(),
  functionUrl: z.string().min(1).max(2048).optional(),
}).strict();

const RevokeKeySchema = z.object({ confirm: z.string().trim().min(1, 'confirm is required').max(64) }).strict();
const ModeSchema = z.object({ mode: z.enum(RUNNER_KEY_MODES) }).strict();
const SystemRevokeSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();
const PauseSchema = z.object({ paused: z.boolean(), reason: z.string().trim().max(500).optional() }).strict();
const StatusQuery = z.object({
  mode: z.enum(RUNNER_KEY_MODES).optional(),
  rotation: z.enum(RUNNER_KEY_ROTATION_STATES).optional(),
  overAge: z.enum(['true', 'false']).optional(),
  unreadable: z.enum(['true', 'false']).optional(),
  inTransition: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Answer 409 RUNNERS_UNAVAILABLE with the shared message for `reason` (the default every runner path uses: paused). */
function sendUnavailable(res: Response, reason: RunnersUnavailableReason | undefined): void {
  const r = reason ?? 'paused';
  sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), RUNNERS_UNAVAILABLE_MESSAGES[r], 'RUNNERS_UNAVAILABLE', { reason: r });
}

/** 409 RUNNERS_UNAVAILABLE (paused, or no secret encryption) — checked before any step-up is spent. */
export async function requireRunnersAvailable(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const a = await runnerDeps().runnersAvailable();
  if (!a.available) return sendUnavailable(res, a.reason);
  next();
}

/**
 * The signing-key writes' gate: 409 RUNNERS_UNAVAILABLE only when runners are
 * not set up (no secret encryption). The operator's pause
 * stops deliveries, not key changes: an admin can still rotate or revoke a
 * suspected-leaked key while every run is paused.
 */
export async function requireRunnersConfigured(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const a = await runnerDeps().runnersAvailable({ ignorePause: true });
  if (!a.available) return sendUnavailable(res, a.reason);
  next();
}

/** What a signing-key write's operation gets. */
type KeyWriteInput = { req: Request; orgId: string; userId: string };

/** Map a runner refusal to the error envelope (`code` + optional `details`). */
function sendRunnerError(res: Response, err: unknown): boolean {
  if (!(err instanceof RunnerRouteError)) return false;
  sendError(res, err.status, err.message, err.code, err.details);
  return true;
}

/** The org's signer, refusing 409 RUNNER_KEY_MISSING / RUNNER_KEY_UNREADABLE (a runner write needs a usable key). */
async function requireUsableKey(deps: RunnerDeps, orgId: string): Promise<void> {
  await deps.signerFor(orgId);
}

// -- The public per-runner JWKS ------------------------------------------------------

/**
 * GET /runners/:runnerId/jwks.json — PUBLIC. Mounted at `/pipelines/runner`
 * ahead of every authenticated chain and the apiCalls meter: the runner Lambda
 * fetches it unauthenticated. Pending and active runners are served (a runner
 * activates only after the signed ping to it succeeds); unknown, malformed and
 * revoked ids, and an owner with no keys, all get the same 404.
 */
export function createRunnerJwksRoutes(): Router {
  const router = Router();
  router.get('/runners/:runnerId/jwks.json', async (req: Request, res: Response) => {
    const deps = runnerDeps();
    const notFound = () => { res.setHeader('Cache-Control', 'no-store'); sendError(res, 404, 'Not found.', ErrorCode.NOT_FOUND); };
    const limited = () => { res.setHeader('Retry-After', '60'); sendError(res, 429, 'Too many key requests; retry in a minute.', ErrorCode.RATE_LIMIT_EXCEEDED); };
    try {
      // Lambdas share AWS egress addresses, so the per-IP limit is a generous backstop.
      if (!(await deps.limiter.hit(`jwks-ip:${req.ip ?? 'unknown'}`, RUNNER_JWKS_IP_REQUESTS_PER_MINUTE, 60_000))) return limited();
      const runnerId = (getParam(req.params, 'runnerId') ?? '').toLowerCase();
      if (!UUID.test(runnerId)) return notFound();
      if (!(await deps.limiter.hit(`jwks-runner:${runnerId}`, RUNNER_JWKS_REQUESTS_PER_MINUTE, 60_000))) return limited();
      const hit = deps.keyCaches.jwks.get(runnerId);
      let body = hit && deps.now() - hit.at < RUNNER_JWKS_CACHE_SECONDS * 1000 ? hit.body : undefined;
      if (body === undefined) {
        const found = await publicKeysForRunner(deps, runnerId);
        if (!found) { deps.keyCaches.jwks.delete(runnerId); return notFound(); }
        body = { keys: found.keys };
        deps.keyCaches.jwks.set(runnerId, { ownerOrgId: found.ownerOrgId, body, at: deps.now() });
      }
      res.setHeader('Cache-Control', `public, max-age=${RUNNER_JWKS_CACHE_SECONDS}`);
      // A bare JWK set (RFC 7517), not the success envelope.
      res.status(200).json(body);
    } catch {
      // Fail closed: the runner treats anything but 200 as "no keys".
      notFound();
    }
  });
  return router;
}

// -- Org-admin routes -------------------------------------------------------------------

/** Runner admin, signing keys, operator controls and run-request status. Self-guarded per route. */
export function createRunnerRoutes(): Router {
  const router = Router();
  const admin = [...createAuthenticatedWithOrgRoute(), requirePermission('org_settings:write')];
  // Writes: MFA-grade session AND a fresh step-up — checked after the
  // availability gate so an unavailable deployment never spends a step-up token.
  const stepUp = [requireAssurance({ minAssurance: 2 }) as RequestHandler, requireStepUp as RequestHandler];
  const write = [...admin, requireRunnersAvailable, ...stepUp];
  // Signing-key writes are not blocked by the delivery pause (only by runners not being set up).
  const keyWrite = [...admin, requireRunnersConfigured, ...stepUp, rateLimitByOrg({
    name: 'pipeline-runner-key-write',
    max: RUNNER_KEY_WRITES_PER_HOUR,
    windowMs: 3_600_000,
    message: `Too many signing-key changes: at most ${RUNNER_KEY_WRITES_PER_HOUR} per organization per hour.`,
    failClosed: true,
  }) as RequestHandler];
  const testLimiter = rateLimitByOrg({ name: 'pipeline-runner-test', max: 5, windowMs: 60_000, message: 'Too many runner tests; wait a minute and try again.' });
  const operatorRead = [...createAuthenticatedWithOrgRoute(), ...requireSystemOrgPermission('orgs:read')];
  const operatorWrite = [...createAuthenticatedWithOrgRoute(), ...requireSystemOrgPermission('orgs:manage'), requireStepUp as RequestHandler];

  router.get('/runners', ...admin, withRoute(async ({ req, res, ctx, orgId }) => {
    const deps = runnerDeps();
    const platformEgressIps = runnerSettings().platformEgressIps;
    // Paused, or no secret encryption: unavailable (never a 500).
    const avail = await deps.runnersAvailable();
    if (!avail.available) {
      return sendSuccess(res, 200, { available: false, unavailableReason: avail.reason ?? null, platformEgressIps, own: [], inherited: [], signingKey: null });
    }
    const parentOrgId = req.user?.parentOrganizationId;
    const { own, inherited } = await listRunners(deps, orgId, parentOrgId);
    const signingKey = await signingKeyDto(deps, orgId);
    ctx.log('COMPLETED', 'Listed pipeline runners', { own: own.length, inherited: inherited.length });
    return sendSuccess(res, 200, { available: true, unavailableReason: null, platformEgressIps, own, inherited, signingKey });
  }));

  // -- Signing key (registered before /runners/:id) --

  /** One key write: run `op`, answer the fresh DTO; a refusal is audited as a failure with its code only. */
  const keyWriteRoute = (action: KeyAuditAction, status: number, op: (deps: RunnerDeps, input: KeyWriteInput) => Promise<unknown>) =>
    withRoute(async ({ req, res, ctx, orgId, userId }) => {
      const deps = runnerDeps();
      try {
        await op(deps, { req, orgId, userId });
        ctx.log('COMPLETED', 'Runner signing key changed', { action });
        return sendSuccess(res, status, await signingKeyDto(deps, orgId));
      } catch (err) {
        if (err instanceof RunnerRouteError) {
          deps.audit({ action, actorId: actorId({ userId }), orgId, targetType: 'pipeline_runner_signing_key', outcome: 'failure', details: { reason: err.code } });
        }
        if (sendRunnerError(res, err)) return;
        throw err;
      }
    });

  const revokeOp = async (deps: RunnerDeps, { req, orgId, userId }: KeyWriteInput) => {
    const body = validateBody(req, RevokeKeySchema);
    if (!body.ok) throw new RunnerRouteError('VALIDATION_ERROR', body.error);
    return revokeOrgKey(deps, orgId, { userId }, body.value.confirm);
  };
  const modeOp = async (deps: RunnerDeps, { req, orgId, userId }: KeyWriteInput) => {
    const body = validateBody(req, ModeSchema);
    if (!body.ok) throw new RunnerRouteError('VALIDATION_ERROR', body.error);
    return setOrgKeyMode(deps, orgId, body.value.mode, { userId });
  };

  /** Every signing-key write: one entry per route, its audit action named once. */
  const KEY_WRITES: ReadonlyArray<{
    method: 'post' | 'delete' | 'put';
    path: string;
    action: KeyAuditAction;
    status: number;
    op: (deps: RunnerDeps, input: KeyWriteInput) => Promise<unknown>;
  }> = [
    { method: 'post', path: '/runners/signing-key', action: 'pipeline.runner.key.generate', status: 201, op: (deps, { orgId, userId }) => generateOrgKey(deps, orgId, { userId }) },
    { method: 'post', path: '/runners/signing-key/rotate', action: 'pipeline.runner.key.rotate', status: 200, op: (deps, { orgId, userId }) => rotateOrgKey(deps, orgId, { userId }) },
    { method: 'delete', path: '/runners/signing-key/rotate', action: 'pipeline.runner.key.cancel', status: 200, op: (deps, { orgId, userId }) => cancelOrgKeyRotation(deps, orgId, { userId }) },
    { method: 'post', path: '/runners/signing-key/finish', action: 'pipeline.runner.key.finish', status: 200, op: (deps, { orgId, userId }) => finishOrgKeyRotation(deps, orgId, { userId }) },
    { method: 'post', path: '/runners/signing-key/revoke', action: 'pipeline.runner.key.revoke', status: 200, op: revokeOp },
    { method: 'put', path: '/runners/signing-key/mode', action: 'pipeline.runner.key.mode', status: 200, op: modeOp },
  ];
  for (const w of KEY_WRITES) router[w.method](w.path, ...keyWrite, audited(w.action), keyWriteRoute(w.action, w.status, w.op));

  // -- Runners --

  router.post('/runners', ...write, audited('pipeline.runner.register'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const body = validateBody(req, RegisterSchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const deps = runnerDeps();
    try {
      // The first runner of an org with no key gets one now (created active: no runner trusts any key of it yet).
      await ensureOrgKeyForFirstRunner(deps, orgId, userId);
      await requireUsableKey(deps, orgId);
      const runner = await registerRunner(deps, orgId, userId, body.value);
      ctx.log('COMPLETED', 'Registered pipeline runner', { runnerId: runner.id });
      recordAudit({
        action: 'pipeline.runner.register',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_runner',
        targetId: runner.id,
        details: { label: runner.label, status: runner.status, regions: runner.regions, version: runner.version },
      });
      return sendSuccess(res, 201, { runner: runnerDto(runner, orgId) });
    } catch (err) {
      recordAudit({
        action: 'pipeline.runner.register',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_runner',
        outcome: 'failure',
        details: { label: body.value.label, reason: err instanceof RunnerRouteError ? err.code : 'error' },
      });
      if (sendRunnerError(res, err)) return;
      throw err;
    }
  }));

  router.patch('/runners/:id', ...write, audited('pipeline.runner.update'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const body = validateBody(req, UpdateSchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const deps = runnerDeps();
    try {
      if (body.value.functionUrl !== undefined) await requireUsableKey(deps, orgId);
      const { runner, changed } = await updateRunner(deps, orgId, userId, id, body.value);
      ctx.log('COMPLETED', 'Updated pipeline runner', { runnerId: runner.id, changed });
      if (changed.length > 0) {
        recordAudit({
          action: 'pipeline.runner.update',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline_runner',
          targetId: runner.id,
          // Which fields changed — never the new URL.
          details: { changed, label: runner.label, shareWithTeams: runner.shareWithTeams, shareDeploysWithTeams: runner.shareDeploysWithTeams },
        });
      }
      return sendSuccess(res, 200, { runner: runnerDto(runner, orgId) });
    } catch (err) {
      if (sendRunnerError(res, err)) return;
      throw err;
    }
  }));

  router.post('/runners/:id/test', ...write, testLimiter, audited('pipeline.runner.test'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    const deps = runnerDeps();
    try {
      await requireUsableKey(deps, orgId);
      const result = await testRunner(deps, orgId, userId, id);
      ctx.log('COMPLETED', 'Tested pipeline runner', { runnerId: id, ok: result.ok });
      recordAudit({
        action: 'pipeline.runner.test',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_runner',
        targetId: id,
        ...(result.ok ? {} : { outcome: 'failure' as const }),
        details: { ok: result.ok, ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.errorCode ? { errorCode: result.errorCode } : {}) },
      });
      return sendSuccess(res, 200, result);
    } catch (err) {
      if (sendRunnerError(res, err)) return;
      throw err;
    }
  }));

  router.delete('/runners/:id', ...write, audited('pipeline.runner.revoke'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const id = getParam(req.params, 'id') ?? '';
    try {
      const { runner, linksCleared, requestsExpired } = await revokeRunner(runnerDeps(), orgId, id);
      // Its JWKS answers 404 from now on, on every replica.
      runnerDeps().keyCaches.jwks.delete(runner.id);
      runnerDeps().publishKeyInvalidation({ kind: 'keys', orgIds: [runner.orgId] });
      ctx.log('COMPLETED', 'Revoked pipeline runner', { runnerId: runner.id, linksCleared, requestsExpired });
      recordAudit({
        action: 'pipeline.runner.revoke',
        actorId: actorId({ userId }),
        orgId,
        targetType: 'pipeline_runner',
        targetId: runner.id,
        details: { label: runner.label, linksCleared, requestsExpired },
      });
      return sendSuccess(res, 200, { runner: runnerDto(runner, orgId) });
    } catch (err) {
      if (sendRunnerError(res, err)) return;
      throw err;
    }
  }));

  // -- Operators (system org) --

  router.get('/admin/runner-signing-keys', ...operatorRead, withRoute(async ({ req, res }) => {
    const q = StatusQuery.safeParse(req.query ?? {});
    if (!q.success) return sendBadRequest(res, q.error.issues[0]?.message ?? 'Invalid query', ErrorCode.VALIDATION_ERROR);
    const { limit, offset, ...f } = q.data;
    const rows = await listKeyStatus(runnerDeps(), {
      ...(f.mode ? { mode: f.mode } : {}),
      ...(f.rotation ? { rotation: f.rotation } : {}),
      overAge: f.overAge === 'true',
      unreadable: f.unreadable === 'true',
      inTransition: f.inTransition === 'true',
    });
    const page = rows.slice(offset, offset + limit);
    return sendPaginatedNested(res, 'orgs', page, { total: rows.length, limit, offset, hasMore: offset + page.length < rows.length });
  }));

  router.post('/admin/orgs/:orgId/runner-signing-key/revoke', ...operatorWrite, audited('pipeline.runner.key.system_revoke'), withRoute(async ({ req, res, userId }) => {
    const target = (getParam(req.params, 'orgId') ?? '').toLowerCase();
    const body = validateBody(req, SystemRevokeSchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const notFound = () => sendError(res, 404, 'Organization not found.', ErrorCode.NOT_FOUND);
    if (!ORG_ID.test(target)) return notFound();
    const deps = runnerDeps();
    const known = (await deps.hierarchy.names([target]))[target] !== undefined || (await deps.keyStore.publishedKeys([target])).length > 0;
    if (!known) return notFound();
    try {
      const out = await revokeOrgKey(deps, target, { userId, system: true, ...(body.value.reason ? { reason: body.value.reason } : {}) }, null);
      return sendSuccess(res, 200, { orgId: target, revokedKid: out.revokedKid, activeKid: out.activeKid });
    } catch (err) {
      if (sendRunnerError(res, err)) return;
      throw err;
    }
  }));

  router.get('/admin/runner-deliveries', ...operatorRead, withRoute(async ({ res }) => {
    const row = await runnerDeps().keyStore.getPause();
    return sendSuccess(res, 200, deliveriesDto(row));
  }));

  router.put('/admin/runner-deliveries', ...operatorWrite, audited('pipeline.runner.deliveries.pause', 'pipeline.runner.deliveries.resume'), withRoute(async ({ req, res, userId }) => {
    const body = validateBody(req, PauseSchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const deps = runnerDeps();
    const row = await deps.keyStore.setPause({ paused: body.value.paused, by: userId || null, reason: body.value.reason ?? null, at: new Date(deps.now()) });
    deps.keyCaches.pause = null;
    deps.publishKeyInvalidation({ kind: 'pause', paused: body.value.paused });
    deps.audit({
      action: body.value.paused ? 'pipeline.runner.deliveries.pause' : 'pipeline.runner.deliveries.resume',
      actorId: actorId({ userId }),
      orgId: SYSTEM_ORG_ID,
      targetType: 'platform',
      targetId: 'runner-deliveries',
      details: body.value.reason ? { reason: body.value.reason } : {},
    });
    return sendSuccess(res, 200, deliveriesDto(row));
  }));

  // -- Run-request status --

  router.get('/:pipelineId/run-requests/:requestId', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read'), withRoute(async ({ req, res, orgId }) => {
    const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
    const requestId = getParam(req.params, 'requestId') ?? '';
    const notFound = () => sendError(res, 404, 'Run request not found.', ErrorCode.NOT_FOUND);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return notFound();
    const dto = await readRunRequest(runnerDeps(), orgId, pipelineId, requestId);
    if (!dto) return notFound();
    return sendSuccess(res, 200, dto);
  }));

  return router;
}

function deliveriesDto(row: { deliveriesPaused: boolean; pausedAt: Date | null; pausedBy: string | null; pauseReason: string | null } | null): RunnerDeliveriesDto {
  return {
    paused: !!row?.deliveriesPaused,
    pausedAt: row?.pausedAt ? row.pausedAt.toISOString() : null,
    pausedBy: row?.pausedBy ?? null,
    reason: row?.pauseReason ?? null,
  };
}

// -- Internal: re-encrypt after a master-key rotation ------------------------------------

const REENCRYPT = PIPELINE_INTERNAL.reencryptRunnerSigningKeys;

/** POST /pipelines/internal/runner-signing-keys/reencrypt — platform's rotation flow (service token only). */
export function createInternalRunnerKeyRoutes(): Router {
  const router: Router = Router();
  router.post(
    contractRoute(REENCRYPT, '/pipelines/internal'),
    requireAuth,
    requireInternalService({ callers: REENCRYPT.callers }),
    audited('pipeline.runner.key.reencrypt'),
    async (req: Request, res: Response) => {
      const body = parseContractBody(REENCRYPT, req);
      if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
      try {
        const result = await reencryptRunnerKeys(runnerDeps(), {
          ...(body.value.orgId ? { orgId: body.value.orgId } : {}),
          ...(body.value.previousKmsConfig !== undefined ? { previousKmsConfig: body.value.previousKmsConfig } : {}),
        });
        return sendSuccess(res, 200, result);
      } catch (err) {
        return sendError(res, 500, `Runner signing keys could not be re-encrypted: ${errorMessage(err).slice(0, 200)}`, ErrorCode.INTERNAL_ERROR);
      }
    },
  );
  return router;
}
