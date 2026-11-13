// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org toolchain default and the eligible-release list
 * (docs/plans/bootstrap-image-versioning.md §5, Phase 4, D13, D15). Every route
 * acts on the CALLER'S OWN org — a team on the team — and never names another:
 *
 *   GET    /plugins/toolchain/org-default          pipelines:read
 *   PUT    /plugins/toolchain/org-default          toolchain:manage + step-up   toolchain.org_default.set
 *   DELETE /plugins/toolchain/org-default          toolchain:manage + step-up   toolchain.org_default.clear
 *   GET    /plugins/toolchain/org-default/history  pipelines:read
 *   GET    /plugins/toolchain/eligible             pipelines:read
 *
 * `requireStepUp` (always on, for people) — not `requireOrgAdminAssurance`,
 * which is a no-op unless the org opted into its MFA policy. Reads never step
 * up. Mounted behind the shared auth + org chain (app-routes.ts), outside the
 * Toolchain console's `releases/*` prefix.
 */

import {
  ErrorCode, audited, requirePermission, requireStepUp, sendBadRequest, sendSuccess, TOOLCHAIN_RELEASE_VERSION_PATTERN, validateBody,
} from '@pipeline-builder/api-core';
import { withRoute } from '@pipeline-builder/api-server';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import {
  clearOrgToolchainDefault, getEligibleToolchainReleases, getOrgToolchainHistory, getOrgToolchainPanel, setOrgToolchainDefault,
} from '../services/org-toolchain-default-service.js';

export const ORG_DEFAULT_PATH = '/org-default';
export const ORG_DEFAULT_HISTORY_PATH = '/org-default/history';
export const ELIGIBLE_PATH = '/eligible';

const SetOrgDefaultBodySchema = z.object({
  releaseVersion: z.string().trim().regex(TOOLCHAIN_RELEASE_VERSION_PATTERN, 'releaseVersion must be a plain MAJOR.MINOR.PATCH release'),
  reason: z.string().trim().max(1000).optional(),
}).strict();

/** Build the router (mounted at `/plugins/toolchain`, behind the shared auth + org chain). */
export function createOrgToolchainDefaultRoutes(): Router {
  const router = Router();
  const read = requirePermission('pipelines:read') as RequestHandler;
  const manage = requirePermission('toolchain:manage') as RequestHandler;
  const stepUp = requireStepUp as RequestHandler;

  router.get(ORG_DEFAULT_PATH, read, withRoute(async ({ res, orgId, userId }) => {
    sendSuccess(res, 200, await getOrgToolchainPanel({ orgId, userId }));
  }));

  router.put(ORG_DEFAULT_PATH, manage, stepUp, audited('toolchain.org_default.set'), withRoute(async ({ req, res, ctx, orgId, userId }) => {
    const body = validateBody(req, SetOrgDefaultBodySchema);
    if (!body.ok) return sendBadRequest(res, body.error, ErrorCode.VALIDATION_ERROR);
    const result = await setOrgToolchainDefault({ orgId, userId }, body.value);
    ctx.log('COMPLETED', 'Org toolchain default set', { releaseVersion: result.orgDefault.releaseVersion, previousReleaseVersion: result.previousReleaseVersion });
    return sendSuccess(res, 200, { orgDefault: result.orgDefault, ...(result.warnings.length ? { warnings: result.warnings } : {}) });
  }));

  router.delete(ORG_DEFAULT_PATH, manage, stepUp, audited('toolchain.org_default.clear'), withRoute(async ({ res, ctx, orgId, userId }) => {
    const result = await clearOrgToolchainDefault({ orgId, userId });
    ctx.log('COMPLETED', 'Org toolchain default cleared', { previousReleaseVersion: result.previousReleaseVersion });
    sendSuccess(res, 200, { orgDefault: null });
  }));

  router.get(ORG_DEFAULT_HISTORY_PATH, read, withRoute(async ({ res, orgId, userId }) => {
    sendSuccess(res, 200, await getOrgToolchainHistory({ orgId, userId }));
  }));

  router.get(ELIGIBLE_PATH, read, withRoute(async ({ res, orgId, userId }) => {
    sendSuccess(res, 200, await getEligibleToolchainReleases({ orgId, userId }));
  }));

  return router;
}
