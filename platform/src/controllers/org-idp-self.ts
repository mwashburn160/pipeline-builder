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
 *   - controller: `requireOwnOrgSso` (helpers/sso-enforcement) — the caller may
 *              only touch THEIR OWN org or a team they manage (path `:id` ∈
 *              {active org, descendant}); AND the org must be `sso`-ENTITLED. An
 *              unentitled/out-of-scope org is 403'd. The group-mapping surface
 *              (controllers/org-idp-mappings.ts) shares that same gate.
 *
 * Everything else — validation, the write-only client-secret handling, the
 * `idpConfigs` quota reservation, the audit actions — lives in
 * `controllers/org-idp-ops.ts` and is shared verbatim with the sysadmin surface,
 * so the two cannot drift apart (they already had: only this surface used to
 * preserve the stored client secret on an update).
 */

import { getParam } from '@pipeline-builder/api-core';
import { deleteOrgIdp, patchOrgIdp, readOrgIdp, upsertOrgIdp } from './org-idp-ops.js';
import { requireAuth, withController } from '../helpers/controller-helper.js';
import { requireOwnOrgSso } from '../helpers/sso-enforcement.js';

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
