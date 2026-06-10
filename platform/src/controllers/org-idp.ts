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
import { orgIdpService, type OrgIdpConfigCreate, type OrgIdpConfigUpdate } from '../services/org-idp-service.js';

const logger = createLogger('org-idp-controller');

function parseCreate(body: unknown): OrgIdpConfigCreate | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  for (const k of ['orgId', 'provider', 'clientId', 'clientSecret']) {
    if (typeof b[k] !== 'string' || (b[k] as string).length === 0) {
      return { error: `${k} is required and must be a non-empty string` };
    }
  }
  const out: OrgIdpConfigCreate = {
    orgId: b.orgId as string,
    provider: b.provider as OrgIdpConfigCreate['provider'],
    clientId: b.clientId as string,
    clientSecret: b.clientSecret as string,
  };
  if (b.discoveryUrl !== undefined) {
    if (typeof b.discoveryUrl !== 'string') return { error: 'discoveryUrl must be a string' };
    out.discoveryUrl = b.discoveryUrl;
  }
  if (b.allowedEmailDomains !== undefined) {
    if (!Array.isArray(b.allowedEmailDomains) || !b.allowedEmailDomains.every((d) => typeof d === 'string')) {
      return { error: 'allowedEmailDomains must be an array of strings' };
    }
    out.allowedEmailDomains = b.allowedEmailDomains as string[];
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = b.enabled;
  }
  if (!['generic-oidc', 'google', 'github'].includes(out.provider)) {
    return { error: "provider must be 'generic-oidc', 'google', or 'github'" };
  }
  if (out.provider === 'generic-oidc' && !out.discoveryUrl) {
    return { error: 'discoveryUrl is required for generic-oidc provider' };
  }
  return out;
}

function parsePatch(body: unknown): OrgIdpConfigUpdate | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const out: OrgIdpConfigUpdate = {};
  if (b.provider !== undefined) {
    if (typeof b.provider !== 'string' || !['generic-oidc', 'google', 'github'].includes(b.provider)) {
      return { error: "provider must be 'generic-oidc', 'google', or 'github'" };
    }
    out.provider = b.provider as OrgIdpConfigUpdate['provider'];
  }
  if (b.clientId !== undefined) {
    if (typeof b.clientId !== 'string') return { error: 'clientId must be a string' };
    out.clientId = b.clientId;
  }
  if (b.clientSecret !== undefined) {
    if (typeof b.clientSecret !== 'string') return { error: 'clientSecret must be a string' };
    out.clientSecret = b.clientSecret;
  }
  if (b.discoveryUrl !== undefined) {
    if (typeof b.discoveryUrl !== 'string') return { error: 'discoveryUrl must be a string' };
    out.discoveryUrl = b.discoveryUrl;
  }
  if (b.allowedEmailDomains !== undefined) {
    if (!Array.isArray(b.allowedEmailDomains) || !b.allowedEmailDomains.every((d) => typeof d === 'string')) {
      return { error: 'allowedEmailDomains must be an array of strings' };
    }
    out.allowedEmailDomains = b.allowedEmailDomains as string[];
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = b.enabled;
  }
  return out;
}

/** GET /api/admin/org-idp  list every configured IdP. */
export const listOrgIdpConfigs = withController('List org IdP configs', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const configs = await orgIdpService.listAll();
  sendSuccess(res, 200, { configs });
});

/** GET /api/admin/org-idp/:orgId  read one. */
export const getOrgIdpConfig = withController('Get org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const id = String(req.params.orgId);
  const config = await orgIdpService.findByOrg(id);
  if (!config) return sendError(res, 404, 'IdP config not found for org');
  sendSuccess(res, 200, { config });
});

/** PUT /api/admin/org-idp/:orgId  upsert (full body required). */
export const putOrgIdpConfig = withController('Put org IdP config', async (req, res) => {
  if (!requireSystemAdmin(req, res)) return;
  const orgId = String(req.params.orgId);

  // Body's orgId may be unset  the URL parameter is canonical.
  const body = { ...(req.body as Record<string, unknown> ?? {}), orgId };
  const parsed = parseCreate(body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

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

  const parsed = parsePatch(req.body);
  if ('error' in parsed) return sendError(res, 400, parsed.error);

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
