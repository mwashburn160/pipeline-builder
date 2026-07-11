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
 * Sysadmin gate is intentional: today this is operator-driven setup on
 * behalf of customers, not a self-serve UI. When the customer-facing
 * self-serve flow lands, it'll add a separate org-admin-scoped route.
 */

import { createLogger, sendError, sendQuotaExceeded, sendSuccess } from '@pipeline-builder/api-core';
import { audit } from '../helpers/audit.js';
import { requireSystemAdmin, withController } from '../helpers/controller-helper.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { orgIdpService } from '../services/org-idp-service.js';
import { orgIdpCreateSchema, orgIdpPatchSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-idp-controller');

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
  const id = String(req.params.orgId);
  const config = await orgIdpService.findByOrg(id);
  sendSuccess(res, 200, { config: config ?? null });
});

/** PUT /api/admin/org-idp/:orgId  upsert (full body required). */
export const putOrgIdpConfig = withController('Put org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  // Body's orgId may be unset  the URL parameter is canonical.
  const body = { ...(req.body as Record<string, unknown> ?? {}), orgId };
  const parsed = validateBody(orgIdpCreateSchema, body, res);
  if (!parsed) return;

  // Reserve quota only when this is a fresh insert; updates of an existing
  // config don't consume a new slot. The service distinguishes by checking
  // for an existing doc, so we mirror that here to avoid double-counting.
  // Today the Mongo unique index caps orgs at one config anyway, but the
  // quota is in place for the day that constraint relaxes.
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
      details: { provider: config.provider },
    });
    sendSuccess(res, 200, { config });
  } catch (err) {
    if (reserved) releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));
    throw err;
  }
});

/** PATCH /api/admin/org-idp/:orgId  partial update. */
export const patchOrgIdpConfig = withController('Patch org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const parsed = validateBody(orgIdpPatchSchema, req.body, res);
  if (!parsed) return;

  const config = await orgIdpService.patch(orgId, req.user!.sub as string, parsed);
  if (!config) return sendError(res, 404, 'IdP config not found for org');
  audit(req, 'admin.org-idp.upsert', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
  });
  sendSuccess(res, 200, { config });
});

/** DELETE /api/admin/org-idp/:orgId  hard remove. */
export const deleteOrgIdpConfig = withController('Delete org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  const ok = await orgIdpService.delete(orgId);
  if (!ok) return sendError(res, 404, 'IdP config not found for org');

  releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));

  audit(req, 'admin.org-idp.delete', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
  });
  sendSuccess(res, 200, {});
});
