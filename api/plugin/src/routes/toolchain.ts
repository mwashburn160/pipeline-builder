// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Managed toolchain routes (docs/plans/bootstrap-image-versioning.md §5, D14).
 *
 * - `POST /plugins/toolchain/initial-default` `{ releaseVersion, acceptVulnerabilities? }`
 *   → 200 `{ releaseVersion }`: the fresh-install platform default, set once by
 *   `init-platform.sh`. IDENTITY-gated, with no step-up: only the
 *   `deploy-bootstrap` SERVICE principal (the ES256 token the deploy scripts
 *   sign). `requireStepUp` refuses every machine, and an org service account
 *   (`principalType: 'service_account'`) or a user is not that principal, so
 *   `requireInternalService` refuses both. A second call is 409
 *   TOOLCHAIN_INITIAL_ALREADY_SET; the §8 guards run with the canary gate
 *   waived, and `acceptVulnerabilities` is the only override of the
 *   vulnerability floor.
 *
 * The `deploy-bootstrap` key sits in the service-key bundle every pod mounts,
 * so `requireAuth` would verify its token on ANY route. This service accepts
 * it on the route above ONLY: {@link refuseDeployBootstrapElsewhere} runs
 * first, ahead of every other mount, and refuses it everywhere else.
 */

import {
  ErrorCode, audited, recordAuthzDenial, requireAuth, requireInternalService, sendBadRequest, sendError, sendSuccess, serviceNameOf, validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { setPlatformDefault } from '../services/toolchain-release-service.js';

/** The deploy scripts' service identity (`sub: service:deploy-bootstrap`). */
export const DEPLOY_BOOTSTRAP_SERVICE = 'deploy-bootstrap';

/** The mount prefix and the one route that identity may call. */
export const TOOLCHAIN_MOUNT = '/plugins/toolchain';
export const INITIAL_DEFAULT_PATH = '/initial-default';

const InitialDefaultBodySchema = z.object({
  releaseVersion: z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'releaseVersion must be a plain MAJOR.MINOR.PATCH release'),
  acceptVulnerabilities: z.string().trim().min(1, 'acceptVulnerabilities needs a reason').max(1000).optional(),
}).strict();

/** The bearer token's claims, UNVERIFIED — enough to refuse, never to admit. */
function unverifiedClaims(req: Request): { principalType?: string; sub?: string } | undefined {
  const parts = req.headers.authorization?.split(' ');
  if (!parts || parts.length !== 2 || parts[0] !== 'Bearer') return undefined;
  const payload = parts[1].split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims as { principalType?: string; sub?: string } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Refuse the `deploy-bootstrap` service principal on every route of this
 * service except `POST /plugins/toolchain/initial-default`. Runs BEFORE
 * `requireAuth`, on the token's unverified claims: it only ever refuses, so a
 * forged token naming the service gains nothing (it is refused here, or by
 * `requireAuth` on the one route that admits the real one).
 */
export function refuseDeployBootstrapElsewhere(req: Request, res: Response, next: NextFunction): void {
  if (serviceNameOf(unverifiedClaims(req)) !== DEPLOY_BOOTSTRAP_SERVICE) return next();
  const path = (req.originalUrl || req.url).split('?')[0].replace(/\/+$/, '');
  if (req.method === 'POST' && path === `${TOOLCHAIN_MOUNT}${INITIAL_DEFAULT_PATH}`) return next();
  recordAuthzDenial(req, `${DEPLOY_BOOTSTRAP_SERVICE} outside ${TOOLCHAIN_MOUNT}${INITIAL_DEFAULT_PATH}`);
  return sendError(res, 403, 'The deploy-bootstrap identity may only set the initial toolchain default', ErrorCode.INSUFFICIENT_PERMISSIONS);
}

export function createToolchainRoutes(): Router {
  const router: Router = Router();

  router.post(
    INITIAL_DEFAULT_PATH,
    requireAuth,
    requireInternalService({ callers: [DEPLOY_BOOTSTRAP_SERVICE] }),
    audited('toolchain.default.initial'),
    withRoute(async ({ req, res, ctx }) => {
      const body = validateBody(req, InitialDefaultBodySchema);
      if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
      const result = await setPlatformDefault({
        releaseVersion: body.value.releaseVersion,
        kind: 'initial',
        actor: `service:${DEPLOY_BOOTSTRAP_SERVICE}`,
        ...(body.value.acceptVulnerabilities ? { acceptVulnerabilities: body.value.acceptVulnerabilities } : {}),
      });
      ctx.log('COMPLETED', 'Initial toolchain default set', { releaseVersion: result.releaseVersion });
      return sendSuccess(res, 200, { releaseVersion: result.releaseVersion });
    }, { requireOrgId: false }),
  );

  return router;
}
