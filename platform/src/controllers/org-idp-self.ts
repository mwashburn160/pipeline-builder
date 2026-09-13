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
 * Everything else — validation, the write-only client-secret handling, the
 * `idpConfigs` quota reservation, the audit actions — lives in
 * `controllers/org-idp-ops.ts` and is shared verbatim with the sysadmin surface,
 * so the two cannot drift apart (they already had: only this surface used to
 * preserve the stored client secret on an update).
 */

import { getParam, sendError } from '@pipeline-builder/api-core';
import { deleteOrgIdp, patchOrgIdp, readOrgIdp, upsertOrgIdp } from './org-idp-ops.js';
import { requireAuth, requireOrgScope, withController } from '../helpers/controller-helper.js';
import { isSsoEntitled } from '../helpers/sso-enforcement.js';

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

  await readOrgIdp(res, orgId);
});

/** PUT /organization/:id/idp — upsert own-org IdP config (full body). */
export const putOwnOrgIdpConfig = withController('Put own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await upsertOrgIdp(req, res, orgId, 'self-service');
});

/** PATCH /organization/:id/idp — partial update of own-org IdP config. */
export const patchOwnOrgIdpConfig = withController('Patch own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await patchOrgIdp(req, res, orgId, 'self-service');
});

/** DELETE /organization/:id/idp — remove own-org IdP config. */
export const deleteOwnOrgIdpConfig = withController('Delete own-org IdP config', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const orgId = getParam(req.params, 'id')!;
  if (!(await requireOwnOrgSso(req, res, orgId))) return;
  await deleteOrgIdp(req, res, orgId, 'self-service');
});
