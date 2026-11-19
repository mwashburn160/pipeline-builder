// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /internal/features/:orgId` → `{ features }` — the org's tier defaults plus
 * its account entitlements (helpers/org-features.ts). The service token must be
 * scoped to the org it asks about, so one caller cannot read every org's flags
 * with a token minted for another.
 */

import { PLATFORM_INTERNAL, contractErrorMessage, isServicePrincipal, parseContractParams, sendError, sendSuccess } from '@pipeline-builder/api-core';
import { withController } from '../helpers/controller-helper.js';
import { resolveOrgFeatures } from '../helpers/org-features.js';

const { orgFeatures: FEATURES } = PLATFORM_INTERNAL;

export const getOrgFeatures = withController('Org features', async (req, res) => {
  const params = parseContractParams(FEATURES, req);
  if (!params.ok) return sendError(res, 400, contractErrorMessage(params));
  const { orgId } = params.value;
  if (!isServicePrincipal(req) || String(req.user?.organizationId ?? '').toLowerCase() !== orgId) {
    return sendError(res, 403, 'The service token must be scoped to the organization it asks about');
  }
  const features = await resolveOrgFeatures(orgId);
  if (!features) return sendError(res, 404, 'Organization not found');
  sendSuccess(res, 200, { features });
});
