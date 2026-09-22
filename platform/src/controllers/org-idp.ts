// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org IdP CRUD (scaffolding).
 *
 * GET /api/admin/org-idp  list all configs (sysadmin)
 * GET /api/admin/org-idp/:orgId  read a single config (sysadmin)
 * PUT /api/admin/org-idp/:orgId  upsert (sysadmin)
 * PATCH /api/admin/org-idp/:orgId  partial update (sysadmin)
 * DELETE /api/admin/org-idp/:orgId  remove (sysadmin)
 *
 * The sysadmin gate is the ONLY thing this surface adds: it is operator-driven
 * setup performed on behalf of a customer. The customer-facing counterpart is
 * `controllers/org-idp-self.ts`, and both delegate their bodies to
 * `helpers/org-idp-ops.ts` so the two surfaces cannot drift apart.
 */

import { sendSuccess } from '@pipeline-builder/api-core';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { deleteOrgIdp, patchOrgIdp, readOrgIdp, upsertOrgIdp } from '../helpers/org-idp-ops.js';
import { ORG_IDP_ERROR_MAP } from '../services/idp-mapping-errors.js';
import { orgIdpService } from '../services/org-idp-service.js';

/** GET /api/admin/org-idp  list every configured IdP. */
export const listOrgIdpConfigs = withController('List org IdP configs', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const configs = await orgIdpService.listAll();
  sendSuccess(res, 200, { configs });
});

/** GET /api/admin/org-idp/:orgId  read one. An org having no IdP config is a
 *  normal state (most orgs never set one up), so this returns 200 with
 *  `config: null` rather than 404 — a 404 spammed the console on every
 *  org-detail load and forced callers to swallow it. */
export const getOrgIdpConfig = withController('Get org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  await readOrgIdp(res, String(req.params.orgId));
});

/** PUT /api/admin/org-idp/:orgId  upsert (full body required). */
export const putOrgIdpConfig = withController('Put org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  await upsertOrgIdp(req, res, String(req.params.orgId), 'admin');
}, ORG_IDP_ERROR_MAP);

/** PATCH /api/admin/org-idp/:orgId  partial update. */
export const patchOrgIdpConfig = withController('Patch org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  await patchOrgIdp(req, res, String(req.params.orgId), 'admin');
}, ORG_IDP_ERROR_MAP);

/** DELETE /api/admin/org-idp/:orgId  hard remove. */
export const deleteOrgIdpConfig = withController('Delete org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  await deleteOrgIdp(req, res, String(req.params.orgId), 'admin');
});
