// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy job's facade — the ONLY platform surface a runner's CodeBuild
 * deploy job reaches, mounted at `/pipelines/runner` ahead of the apiCalls
 * meter and every user auth chain (the job holds no user token):
 *
 * - POST /pipelines/runner/deploys/:requestId/session        {grant} → a session token (no-store). The grant is single use.
 * - GET  /pipelines/runner/deploys/:requestId/pipeline       the pipeline as `GET /pipelines/:id` answers it (what synth reads).
 * - POST /pipelines/runner/deploys/:requestId/plugin-lookup  a plugin lookup as the pipeline's org (proxied to the plugin service).
 * - POST /pipelines/runner/deploys/:requestId/progress       {stage}.
 * - POST /pipelines/runner/deploys/:requestId/registry       the deployed pipeline's registration (org, pipeline, runner from the session).
 * - POST /pipelines/runner/deploys/:requestId/result         {code, stage?}.
 *
 * Every route but `session` takes `Authorization: Bearer <session token>`,
 * valid only for its own request id, until the deploy deadline, while the
 * deploy runs. Refusals are 401 DEPLOY_GRANT_INVALID with `details.reason`.
 * Per request id (and per IP) rate limited. No answer carries an AWS account
 * id, a URL of the platform's, or anything of another org.
 */

import {
  audited, callInternal, ErrorCode, errorMessage, getParam, getServiceAuthHeader, InternalHttpClient, normalizeArrayFields,
  PLUGIN_INTERNAL, recordAudit, sendError, sendSuccess, serviceEndpoint, serviceIdentity, SYSTEM_ACTOR_ID, SYSTEM_ORG_ID,
} from '@pipeline-builder/api-core';
import {
  DEPLOY_JOB_RESULT_CODES, DEPLOY_STAGES,
} from '@pipeline-builder/api-core/pipeline-runners';
import { runWithTenantContext } from '@pipeline-builder/pipeline-data';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { MAX_MANIFEST_STEPS, StepManifestEntrySchema } from './registry.js';
import { authenticateDeploySession, exchangeDeployGrant } from '../runners/deploy-grants.js';
import { recordDeployProgress, recordDeployResult } from '../runners/deploys.js';
import { runnerDeps } from '../runners/deps.js';
import { RunnerRouteError } from '../runners/routing.js';
import type { DeployRequestPair } from '../runners/store.js';
import { PR_PIPELINE_NOT_OWNED, PR_REGISTRY_OWNED_BY_OTHER_ORG } from '../services/pipeline-registry-service.js';
import { pipelineService } from '../services/pipeline-service.js';

/** Calls one deploy's job may make per minute (a job makes a handful, plus one lookup per plugin). */
export const DEPLOY_SESSION_REQUESTS_PER_MINUTE = 120;
/** The per-IP backstop (CodeBuild shares AWS egress addresses). */
export const DEPLOY_SESSION_IP_REQUESTS_PER_MINUTE = 1200;


const SessionBody = z.object({ grant: z.string().min(1).max(200) }).strict();
const ProgressBody = z.object({ stage: z.enum(DEPLOY_STAGES) }).strict();
const ResultBody = z.object({ code: z.enum(DEPLOY_JOB_RESULT_CODES), stage: z.enum(DEPLOY_STAGES).optional() }).strict();
const RegistryBody = z.object({
  pipelineName: z.string().min(1).max(255),
  stackName: z.string().min(1).max(255),
  region: z.string().min(1).max(30),
  steps: z.array(StepManifestEntrySchema).max(MAX_MANIFEST_STEPS).optional(),
}).strict();
const LookupBody = z.object({ filter: z.record(z.string(), z.unknown()), context: z.unknown().optional(), releasePin: z.unknown().optional() }).strict();

/** The session-authenticated deploy, for the handler. */
type SessionRequest = Request & { deploySession?: DeployRequestPair };

function sendRunnerError(res: Response, err: unknown): boolean {
  if (!(err instanceof RunnerRouteError)) return false;
  sendError(res, err.status, err.message, err.code, err.details);
  return true;
}

function badBody(res: Response, err: z.ZodError): void {
  sendError(res, 400, err.issues[0]?.message ?? 'Invalid body', ErrorCode.VALIDATION_ERROR);
}

/** Per request id and per IP. */
function limited(perId: string): RequestHandler {
  return async (req, res, next) => {
    const deps = runnerDeps();
    const id = (getParam(req.params, 'requestId') ?? '').toLowerCase().slice(0, 64);
    const ok = await deps.limiter.hit(`deploy-session-ip:${req.ip ?? 'unknown'}`, DEPLOY_SESSION_IP_REQUESTS_PER_MINUTE, 60_000)
      && await deps.limiter.hit(`${perId}:${id}`, DEPLOY_SESSION_REQUESTS_PER_MINUTE, 60_000);
    if (!ok) {
      res.setHeader('Retry-After', '60');
      return sendError(res, 429, 'Too many deploy job requests; retry in a minute.', ErrorCode.RATE_LIMIT_EXCEEDED);
    }
    next();
  };
}

/** The session gate: the bearer token must be this request's live session. */
async function requireDeploySession(req: SessionRequest, res: Response, next: NextFunction): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    req.deploySession = await authenticateDeploySession(runnerDeps(), getParam(req.params, 'requestId') ?? '', req.headers.authorization);
    next();
  } catch (err) {
    if (sendRunnerError(res, err)) return;
    sendError(res, 500, 'Deploy session check failed.', ErrorCode.INTERNAL_ERROR);
  }
}

/** One async facade handler: refusals in the envelope, anything else a bare 500. */
const handle = (fn: (req: SessionRequest, res: Response) => Promise<unknown>): RequestHandler => async (req, res) => {
  try {
    await fn(req as SessionRequest, res);
  } catch (err) {
    if (sendRunnerError(res, err)) return;
    if (!res.headersSent) sendError(res, 500, 'Deploy job request failed.', ErrorCode.INTERNAL_ERROR);
  }
};

export function createDeploySessionRoutes(): Router {
  const router = Router();
  // No user chain: the authority is the request's own credential, checked in
  // `requireDeploySession` (the route table carries these as reasoned
  // exceptions in test/route-coverage.test.ts, like the public JWKS route).
  const session = [limited('deploy-session'), requireDeploySession as RequestHandler];

  router.post('/deploys/:requestId/session', limited('deploy-grant'), audited('pipeline.deploy.grant_reuse'),
    handle(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const body = SessionBody.safeParse(req.body ?? {});
      // A malformed body is refused as an unknown grant (nothing about why).
      const dto = await exchangeDeployGrant(runnerDeps(), getParam(req.params, 'requestId') ?? '', body.success ? body.data.grant : undefined);
      return sendSuccess(res, 200, dto);
    }));

  router.get('/deploys/:requestId/pipeline', ...session, handle(async (req, res) => {
    const { request } = req.deploySession!;
    // As the pipeline's own org: exactly what `GET /pipelines/:id` serves that org.
    const row = await runWithTenantContext({ orgId: request.orgId, isSuperAdmin: false }, () => pipelineService.findById(request.pipelineId, request.orgId));
    if (!row || row.orgId.toLowerCase() !== request.orgId.toLowerCase()) return sendError(res, 404, 'Pipeline not found.', ErrorCode.NOT_FOUND);
    return sendSuccess(res, 200, { pipeline: normalizeArrayFields(row, ['keywords']) });
  }));

  router.post('/deploys/:requestId/plugin-lookup', ...session, handle(async (req, res) => {
    const body = LookupBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const { request } = req.deploySession!;
    const client = new InternalHttpClient(serviceEndpoint('plugin'));
    let out: Awaited<ReturnType<typeof callInternal<typeof PLUGIN_INTERNAL.deployLookup>>>;
    try {
      out = await callInternal(client, PLUGIN_INTERNAL.deployLookup, {
        params: { orgId: request.orgId },
        body: body.data,
        options: { headers: { Authorization: getServiceAuthHeader({ serviceName: serviceIdentity(), orgId: SYSTEM_ORG_ID, role: 'member' }) } },
      });
    } catch (err) {
      return sendError(res, 502, `Plugin lookup failed (${errorMessage(err).slice(0, 120)}).`, ErrorCode.INTERNAL_ERROR);
    }
    // The plugin service's own envelope, as POST /plugins/lookup answers it.
    if (out.ok) return res.status(out.status).json(out.body);
    // The plugin service's own refusal (404 / 400 / 409 / 410), as the user route would answer it.
    if (out.reason === 'status' && out.status < 500 && out.body && typeof out.body === 'object') return res.status(out.status).json(out.body);
    return sendError(res, 502, 'Plugin lookup failed.', ErrorCode.INTERNAL_ERROR);
  }));

  router.post('/deploys/:requestId/progress', ...session, handle(async (req, res) => {
    const body = ProgressBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    await recordDeployProgress(runnerDeps(), req.deploySession!, body.data.stage);
    return sendSuccess(res, 200, { stage: body.data.stage });
  }));

  router.post('/deploys/:requestId/result', ...session, handle(async (req, res) => {
    const body = ResultBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    await recordDeployResult(runnerDeps(), req.deploySession!, body.data.code, body.data.stage);
    return sendSuccess(res, 200, { code: body.data.code });
  }));

  router.post('/deploys/:requestId/registry', ...session, audited('pipeline.registry.register'), handle(async (req, res) => {
    const body = RegistryBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const { request, deploy } = req.deploySession!;
    if (request.action !== 'deploy') return sendError(res, 409, 'An undeploy registers nothing.', ErrorCode.CONFLICT);
    // The names and region must be the deploy's own: the job can't register anything else.
    const b = body.data;
    if (b.pipelineName !== deploy.pipelineName || b.stackName !== deploy.stackName || b.region !== deploy.region) {
      return sendError(res, 409, 'The registration does not match the deploy\'s pipeline name, stack name or region.', 'DEPLOY_TARGET_MISMATCH');
    }
    const deps = runnerDeps();
    try {
      // THE shared upsert: org, pipeline and runner come from the session; the
      // runner's own job deployed it, which is what links it.
      const result = await deps.registry.registerDeployment({
        pipelineId: request.pipelineId,
        orgId: request.orgId,
        pipelineName: deploy.pipelineName,
        stackName: deploy.stackName,
        region: deploy.region,
        runnerId: request.runnerId ?? undefined,
        ...(b.steps ? { steps: b.steps } : {}),
      });
      recordAudit({
        action: 'pipeline.registry.register',
        actorId: SYSTEM_ACTOR_ID,
        orgId: request.orgId,
        targetType: 'pipeline',
        targetId: request.pipelineId,
        details: {
          source: 'runner-deploy',
          registryId: result.registryId,
          requestId: request.id,
          runnerId: request.runnerId,
          pipelineName: deploy.pipelineName,
          stackName: deploy.stackName,
          region: deploy.region,
          inserted: result.inserted,
          linked: result.linked,
          ...(result.manifestSteps !== undefined ? { manifestSteps: result.manifestSteps } : {}),
        },
      });
      return sendSuccess(res, 200, { registryId: result.registryId, linked: result.linked });
    } catch (err) {
      const code = errorMessage(err);
      if (code === PR_PIPELINE_NOT_OWNED) return sendError(res, 404, 'Pipeline not found.', ErrorCode.NOT_FOUND);
      if (code === PR_REGISTRY_OWNED_BY_OTHER_ORG) return sendError(res, 409, 'Pipeline is registered to a different organization', ErrorCode.CONFLICT);
      throw err;
    }
  }));

  return router;
}
