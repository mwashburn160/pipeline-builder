// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org IdP write operations, shared by BOTH surfaces that expose them:
 * the operator-driven `/admin/org-idp/*` routes (controllers/org-idp.ts) and the
 * customer-facing `/organization/:id/idp` routes (controllers/org-idp-self.ts).
 *
 * WHY this module exists: the two controllers were near-verbatim copies, and
 * they had already diverged in a way users could hit. The self-service PUT
 * re-injected the stored client secret when the body omitted it; the sysadmin
 * PUT did not — so the SAME edit (change the issuer, leave the write-only
 * secret field blank) succeeded through the customer UI and, through the
 * operator UI, either failed `orgIdpCreateSchema`'s required-secret rule or
 * overwrote the stored secret. Same capability, two behaviours, decided by
 * which page you were on.
 *
 * Each surface keeps ONLY what genuinely differs: its auth/tenancy gate (applied
 * before these are called) and its `surface` audit tag.
 */

import { createLogger, sendError, sendQuotaReserveDenied, sendSuccess } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from '../helpers/audit.js';
import { releaseFeatureQuota, reserveFeatureQuota } from '../middleware/quota.js';
import { orgIdpService } from '../services/org-idp-service.js';
import { orgIdpCreateSchema, orgIdpPatchSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-idp-ops');

/** Which route family invoked the operation — recorded on the audit event so the
 *  trail distinguishes an operator acting FOR a customer from the customer's own
 *  admin acting for themselves. */
export type IdpSurface = 'admin' | 'self-service';

/** Read one org's config. A missing config is a NORMAL state (most orgs never
 *  set one up), so this is 200 with `config: null` rather than 404 — a 404
 *  spammed the console on every org-detail load and forced callers to swallow it. */
export async function readOrgIdp(res: Response, orgId: string): Promise<void> {
  const config = await orgIdpService.findByOrg(orgId);
  sendSuccess(res, 200, { config: config ?? null });
}

/** Upsert an org's IdP config from a FULL body. */
export async function upsertOrgIdp(req: Request, res: Response, orgId: string, surface: IdpSurface): Promise<void> {
  // The URL parameter is canonical — a caller can't point the write at another
  // org via the body.
  const body: Record<string, unknown> = { ...(req.body as Record<string, unknown> ?? {}), orgId };

  // Load the existing config up front; it decides two things below.
  const existing = await orgIdpService.findByOrg(orgId);

  // The IdP form is WRITE-ONLY for the client secret (it is never sent back on
  // read), so an update that omits the secret means "keep the stored one" —
  // otherwise editing any other field, or switching provider, would either fail
  // the required-secret validation or wipe the secret. Re-inject the stored
  // plaintext before validation; `upsert` re-encrypts it and it is never
  // returned to the caller. A fresh create has no stored secret, so the
  // schema's required-secret rule still applies there.
  if (existing && !body.clientSecret) {
    const login = await orgIdpService.getLoginConfig(orgId);
    if (login) body.clientSecret = login.clientSecret;
  }

  const parsed = validateBody(orgIdpCreateSchema, body, res);
  if (!parsed) return;

  // Reserve the `idpConfigs` slot only on a fresh insert; updating an existing
  // config doesn't consume a new one. The per-org unique index caps orgs at one
  // config today, but the quota is in place for the day that relaxes.
  let reserved = false;
  if (!existing) {
    const reservation = await reserveFeatureQuota(orgId, 'idpConfigs');
    if (reservation.exceeded) {
      sendQuotaReserveDenied(res, 'idpConfigs', reservation);
      return;
    }
    reserved = true;
  }

  try {
    const config = await orgIdpService.upsert(req.user!.sub as string, parsed);
    audit(req, 'admin.org-idp.upsert', {
      targetType: 'org-idp-config',
      targetId: orgId,
      affectedOrgId: orgId,
      details: { provider: config.provider, surface },
    });
    sendSuccess(res, 200, { config });
  } catch (err) {
    if (reserved) releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));
    throw err;
  }
}

/** Partially update an org's IdP config. */
export async function patchOrgIdp(req: Request, res: Response, orgId: string, surface: IdpSurface): Promise<void> {
  const parsed = validateBody(orgIdpPatchSchema, req.body, res);
  if (!parsed) return;

  const config = await orgIdpService.patch(orgId, req.user!.sub as string, parsed);
  if (!config) {
    sendError(res, 404, 'IdP config not found for org');
    return;
  }
  audit(req, 'admin.org-idp.upsert', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { surface },
  });
  sendSuccess(res, 200, { config });
}

/** Hard-remove an org's IdP config and give back its quota slot. */
export async function deleteOrgIdp(req: Request, res: Response, orgId: string, surface: IdpSurface): Promise<void> {
  const ok = await orgIdpService.delete(orgId);
  if (!ok) {
    sendError(res, 404, 'IdP config not found for org');
    return;
  }

  releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger));

  audit(req, 'admin.org-idp.delete', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { surface },
  });
  sendSuccess(res, 200, {});
}
