// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ORG-ADMIN SELF-SERVICE for per-org IdP (SSO) configuration.
 *
 *   GET    /organization/:id/idp  → read own-org config
 *   PUT    /organization/:id/idp  → upsert (full body)
 *   PATCH  /organization/:id/idp  → partial update
 *   DELETE /organization/:id/idp  → remove
 *
 * The customer-facing counterpart to the superadmin `/admin/org-idp/*` fleet
 * surface (controllers/org-idp.ts): it lets a customer's OWN admin manage their
 * org's SSO without an operator. Layered gates:
 *   - route:   `requirePermission('org:settings')` — the org-assignable capability
 *              that already governs IdP/KMS/AI/general org settings (see the RBAC
 *              catalog note on `org:settings`), plus `requireStepUp` on the
 *              secret-bearing writes (mirrors the sysadmin routes).
 *   - controller: `requireOrgScope` — the caller may only touch THEIR OWN org or a
 *              team they manage (path `:id` ∈ {active org, descendant}); AND the
 *              org must be `sso`-ENTITLED. An unentitled/out-of-scope org is 403'd.
 *
 * Everything else — the `orgIdpService`, the `idpConfigs` quota reservation, the
 * audit actions — is REUSED from the sysadmin path so both surfaces stay in lockstep.
 */

import { createLogger, getParam, sendError, sendQuotaExceeded, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireAuth, requireOrgScope, withController } from '../helpers/controller-helper.js';
import { isSsoEntitled } from '../helpers/sso-enforcement.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { orgIdpService } from '../services/org-idp-service.js';
import { orgIdpCreateSchema, orgIdpPatchSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-idp-self-controller');

/**
 * Shared tenancy + entitlement gate for the self-service surface. Confirms the
 * caller may manage `orgId` (own org / managed descendant) AND the org is
 * `sso`-entitled. Returns false (and has responded) when either fails.
 */
async function requireOwnOrgSso(req: Parameters<typeof requireOrgScope>[0], res: Parameters<typeof requireOrgScope>[1], orgId: string): Promise<boolean> {
  if (!(await requireOrgScope(req, res, orgId))) return false;
  if (!(await isSsoEntitled(orgId))) {
    sendError(res, 403, 'This organization is not entitled to SSO', 'SSO_NOT_ENTITLED');
    return false;
  }
  return true;
}

/** GET /organization/:id/idp — read own-org IdP config (200 with `config: null`
 *  when none is set, mirroring the sysadmin read). */
export const getOwnOrgIdpConfig = withController('Get own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const config = await orgIdpService.findByOrg(orgId);
  sendSuccess(res, 200, { config: config ?? null });
});

/** PUT /organization/:id/idp — upsert own-org IdP config (full body). */
export const putOwnOrgIdpConfig = withController('Put own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  // Body's orgId may be unset — the URL parameter is canonical (a caller can't
  // point the write at another org via the body).
  const body = { ...(req.body as Record<string, unknown> ?? {}), orgId };
  const parsed = validateBody(orgIdpCreateSchema, body, res);
  if (!parsed) return;

  // Reserve the `idpConfigs` slot only on a fresh insert (mirrors the sysadmin
  // path; the per-org unique index caps at one today but the quota is future-proof).
  const existing = await orgIdpService.findByOrg(orgId);
  let reserved = false;
  if (!existing) {
    const reservation = await reserveFeatureQuota(orgId, 'idpConfigs');
    if (reservation.exceeded) {
      return sendQuotaExceeded(res, 'idpConfigs', reservation.quota, reservation.quota.resetAt);
    }
    reserved = true;
  }

  try {
    const config = await orgIdpService.upsert(req.user!.sub as string, parsed);
    audit(req, 'admin.org-idp.upsert', {
      targetType: 'org-idp-config',
      targetId: orgId,
      affectedOrgId: orgId,
      details: { provider: config.provider, surface: 'self-service' },
    });
    sendSuccess(res, 200, { config });
  } catch (err) {
    if (reserved) releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));
    throw err;
  }
});

/** PATCH /organization/:id/idp — partial update of own-org IdP config. */
export const patchOwnOrgIdpConfig = withController('Patch own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const parsed = validateBody(orgIdpPatchSchema, req.body, res);
  if (!parsed) return;

  const config = await orgIdpService.patch(orgId, req.user!.sub as string, parsed);
  if (!config) return sendError(res, 404, 'IdP config not found for org');
  audit(req, 'admin.org-idp.upsert', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { surface: 'self-service' },
  });
  sendSuccess(res, 200, { config });
});

/** DELETE /organization/:id/idp — remove own-org IdP config. */
export const deleteOwnOrgIdpConfig = withController('Delete own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;

  const ok = await orgIdpService.delete(orgId);
  if (!ok) return sendError(res, 404, 'IdP config not found for org');

  releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));

  audit(req, 'admin.org-idp.delete', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { surface: 'self-service' },
  });
  sendSuccess(res, 200, {});
});
