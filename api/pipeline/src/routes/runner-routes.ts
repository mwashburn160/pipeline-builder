// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-account pipeline runner routes.
 *
 * - GET    /pipelines/runner/jwks.json         PUBLIC — the run-request signing keys.
 * - GET    /pipelines/runners                  org_settings:write — own + inherited runners.
 * - POST   /pipelines/runners                  org_settings:write + MFA-grade + step-up — register (signed ping).
 * - PATCH  /pipelines/runners/:id              org_settings:write + MFA-grade + step-up — rename / share / new URL.
 * - POST   /pipelines/runners/:id/test         org_settings:write + MFA-grade + step-up, 5/min/org — signed ping.
 * - DELETE /pipelines/runners/:id              org_settings:write + MFA-grade + step-up — revoke.
 * - GET    /pipelines/:pipelineId/run-requests/:requestId   pipelines:read — a queued run's progress.
 *
 * Every admin route requires the org's `cross_account_runners` feature
 * (operator-granted; the standard feature refusal otherwise). When the
 * deployment has no runner signing key, writes and the JWKS answer 409
 * RUNNERS_UNAVAILABLE and the list answers `available: false`.
 */

import {
  actorId,
  audited,
  ErrorCode,
  getParam,
  recordAudit,
  requireAssurance,
  requireFeature,
  requirePermission,
  requireStepUp,
  sendBadRequest,
  sendError,
  sendSuccess,
  validateBody,
} from '@pipeline-builder/api-core';
import { RUNNER_JWKS_PATH, runnerErrorStatus } from '@pipeline-builder/api-core/pipeline-runners';
import { createAuthenticatedWithOrgRoute, rateLimitByOrg, withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { listRunners, registerRunner, revokeRunner, runnerDto, testRunner, updateRunner } from '../runners/admin.js';
import { runnerDeps, runnersAvailable, runnerTablesPresent } from '../runners/deps.js';
import { RunnerRouteError } from '../runners/routing.js';
import { readRunRequest } from '../runners/run-request-status.js';
import { principalHasRunnerFeature, RUNNER_FEATURE, runnerSettings } from '../runners/vocabulary.js';

const REGION = z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'regions must be AWS region names');
const LABEL = z.string().trim().min(1, 'label is required').max(100);

const RegisterSchema = z.object({
  label: LABEL,
  // Omitted → a `pending` runner (register, then deploy the stack with its id, then PATCH the URL).
  functionUrl: z.string().min(1).max(2048).optional(),
  regions: z.array(REGION).max(30).optional(),
}).strict();

const UpdateSchema = z.object({
  label: LABEL.optional(),
  shareWithTeams: z.boolean().optional(),
  functionUrl: z.string().min(1).max(2048).optional(),
}).strict();

const UNAVAILABLE_MESSAGE = 'Cross-account pipeline runners are not set up on this deployment (no runner signing key).';
const NO_TABLES_MESSAGE = 'Cross-account pipeline runners are not set up on this deployment: the database has no runner tables. The platform operator must create them (pipeline_runners, pipeline_run_requests — see postgres-init.sql).';

/**
 * 409 RUNNERS_UNAVAILABLE unless a runner signing key loaded AND the database
 * has the runner tables (checked before any step-up is spent).
 */
export async function requireRunnersAvailable(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!runnersAvailable()) return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), UNAVAILABLE_MESSAGE, 'RUNNERS_UNAVAILABLE');
  if (!(await runnerTablesPresent(runnerDeps()))) return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), NO_TABLES_MESSAGE, 'RUNNERS_UNAVAILABLE');
  next();
}

/** Record that this org (still) holds the feature — the dispatcher's per-job re-check reads it. */
function noteFeature(req: Request, _res: Response, next: NextFunction): void {
  const orgId = req.user?.organizationId;
  if (orgId && runnersAvailable()) void runnerDeps().noteOrgFeature(orgId, true).catch(() => undefined);
  next();
}

/** Map a runner refusal to the error envelope (`code` + optional `details`). */
function sendRunnerError(res: Response, err: unknown): boolean {
  if (!(err instanceof RunnerRouteError)) return false;
  sendError(res, err.status, err.message, err.code, err.details);
  return true;
}

/** Public JWKS URL the runner fetches (PLATFORM_BASE_URL + the gateway path). */
export function jwksUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.PLATFORM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return `${base}${RUNNER_JWKS_PATH}`;
}

/**
 * The PUBLIC signing-key set. Mounted at `/pipelines/runner` ahead of every
 * authenticated chain (and the apiCalls meter): the runner Lambda fetches it
 * unauthenticated.
 */
export function createRunnerJwksRoutes(): Router {
  const router = Router();
  router.get('/jwks.json', (_req: Request, res: Response) => {
    const signer = runnersAvailable() ? runnerDeps().signer() : null;
    if (!signer) return sendError(res, runnerErrorStatus('RUNNERS_UNAVAILABLE'), UNAVAILABLE_MESSAGE, 'RUNNERS_UNAVAILABLE');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // A bare JWK set (RFC 7517), not the success envelope: runners and any
    // standard JOSE library read `{ keys }` at the top level.
    res.status(200).json(signer.jwks());
  });
  return router;
}

/** Runner admin + run-request status. Self-guarded per route. */
export function createRunnerRoutes(): Router {
  const router = Router();
  // The org must hold the operator-granted `cross_account_runners` feature.
  const admin = [...createAuthenticatedWithOrgRoute(), requireFeature(RUNNER_FEATURE), requirePermission('org_settings:write'), noteFeature];
  // Writes: MFA-grade session AND a fresh step-up — checked after the
  // availability gate so an unavailable deployment never spends a step-up token.
  const write = [...admin, requireRunnersAvailable, requireAssurance({ minAssurance: 2 }) as RequestHandler, requireStepUp as RequestHandler];
  const testLimiter = rateLimitByOrg({ name: 'pipeline-runner-test', max: 5, windowMs: 60_000, message: 'Too many runner tests; wait a minute and try again.' });

  router.get('/runners', ...admin, withRoute(async ({ req, res, ctx, orgId }) => {
    const platformEgressIps = runnerSettings().platformEgressIps;
    // No signing key, or a database without the runner tables: unavailable (never a 500).
    if (!runnersAvailable() || !(await runnerTablesPresent(runnerDeps()))) return sendSuccess(res, 200, { available: false, jwksUrl: jwksUrl(), platformEgressIps, own: [], inherited: [] });
    const parentOrgId = req.user?.parentOrganizationId;
    const { own, inherited } = await listRunners(runnerDeps(), orgId, parentOrgId);
    ctx.log('COMPLETED', 'Listed pipeline runners', { own: own.length, inherited: inherited.length });
    return sendSuccess(res, 200, { available: true, jwksUrl: jwksUrl(), platformEgressIps, own, inherited });
  }));

  router.post('/runners', ...write, audited('pipeline.runner.register'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const body = validateBody(req, RegisterSchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    try {
      const runner = await registerRunner(runnerDeps(), orgId, userId, body.value);
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
    try {
      const { runner, changed } = await updateRunner(runnerDeps(), orgId, userId, id, body.value);
      ctx.log('COMPLETED', 'Updated pipeline runner', { runnerId: runner.id, changed });
      if (changed.length > 0) {
        recordAudit({
          action: 'pipeline.runner.update',
          actorId: actorId({ userId }),
          orgId,
          targetType: 'pipeline_runner',
          targetId: runner.id,
          // Which fields changed — never the new URL.
          details: { changed, label: runner.label, shareWithTeams: runner.shareWithTeams },
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
    try {
      const result = await testRunner(runnerDeps(), orgId, userId, id);
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

  router.get('/:pipelineId/run-requests/:requestId', ...createAuthenticatedWithOrgRoute(), requirePermission('pipelines:read'), withRoute(async ({ req, res, orgId }) => {
    const pipelineId = (getParam(req.params, 'pipelineId') ?? '').toLowerCase();
    const requestId = getParam(req.params, 'requestId') ?? '';
    const notFound = () => sendError(res, 404, 'Run request not found.', ErrorCode.NOT_FOUND);
    // An org without the feature has no runner requests to read (404, like none).
    if (!/^[0-9a-f-]{36}$/i.test(requestId) || !runnersAvailable() || !principalHasRunnerFeature(req.user) || !(await runnerTablesPresent(runnerDeps()))) return notFound();
    const dto = await readRunRequest(runnerDeps(), orgId, pipelineId, requestId);
    if (!dto) return notFound();
    return sendSuccess(res, 200, dto);
  }));

  return router;
}
