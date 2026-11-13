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
 * `deploy-bootstrap` is an OPT-IN signer (api-core `OPT_IN_SERVICE_SIGNERS`):
 * every `requireAuth` rejects its token at verification unless the route names
 * it in `acceptServices`. The route above is the only one in this service that
 * does, so no other route can admit it — there is no service-wide refusal
 * middleware to keep in step.
 */

import {
  ErrorCode, audited, requireAuth, requireInternalService, sendBadRequest, sendSuccess, validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router } from 'express';
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

export function createToolchainRoutes(): Router {
  const router: Router = Router();

  router.post(
    INITIAL_DEFAULT_PATH,
    // Opt in to the deploy-bootstrap signer for THIS route only, then require
    // that exact identity: any other principal the verifier admits is refused.
    requireAuth({ acceptServices: [DEPLOY_BOOTSTRAP_SERVICE] }),
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
