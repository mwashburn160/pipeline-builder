// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-org IdP write operations, shared by BOTH surfaces that expose them:
 * the operator-driven `/admin/org-idp/*` routes (controllers/org-idp.ts) and the
 * customer-facing `/organization/:id/idp` routes (controllers/org-idp-self.ts).
 *
 * One implementation, so the same edit (e.g. change the issuer, leave the
 * write-only secret field blank — the stored secret is re-injected) behaves the
 * same whichever page it came from.
 *
 * Each surface keeps ONLY what genuinely differs: its auth/tenancy gate (applied
 * before these are called) and its `surface` audit tag.
 */

import crypto from 'crypto';
import { createLogger, sendError, sendSuccess } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { audit } from './audit.js';
import { hasVerifiedDomain, unverifiedDomains } from './sso-enforcement.js';
import { releaseFeatureQuota, withFeatureQuota } from '../middleware/quota.js';
import { incCounter } from '../observability/metrics.js';
import { IDP_DOMAIN_NOT_VERIFIED, IDP_SECRET_REQUIRED, IDP_SSO_REQUIRED_NO_DOMAIN } from '../services/idp-mapping-errors.js';
import { type OrgIdpConfigDto, orgIdpService } from '../services/org-idp-service.js';
import { orgIdpCreateSchema, orgIdpPatchSchema, validateBody } from '../utils/validation.js';

const logger = createLogger('org-idp-ops');

/** SHA-256 fingerprint of a certificate, over its base64 payload so the PEM
 *  wrapper and whitespace don't change it. Short-form for the audit trail: the
 *  certificate itself is public, but the audit row wants an identifier, not a
 *  20-line blob. */
function certFingerprint(cert: string): string {
  const payload = cert.replace(/-----(BEGIN|END)[A-Z ]+-----/g, '').replace(/\s+/g, '');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Record a change to the org's trusted SAML signing certificates.
 *
 * Kept separate from the surrounding `admin.org-idp.upsert` because a
 * certificate swap is the one IdP edit that decides, on its own, whose
 * assertions this org will accept — including the moment a rotation's overlap
 * window opens and (more importantly) whether it was ever closed. A no-op write
 * records nothing, so the trail shows rotations, not saves.
 */
function auditCertificateRotation(
  req: Request,
  orgId: string,
  before: readonly string[],
  after: readonly string[],
  surface: IdpSurface,
): void {
  const beforePrints = before.map(certFingerprint);
  const afterPrints = after.map(certFingerprint);
  if (beforePrints.join(',') === afterPrints.join(',')) return;
  audit(req, 'sso.saml.certificate.rotate', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: {
      surface,
      before: beforePrints,
      after: afterPrints,
      // > 1 means an overlap window is OPEN: assertions signed by either
      // certificate are accepted until the retiring one is removed.
      overlap: afterPrints.length > 1,
    },
  });
  incCounter('platform_saml_certificate_rotations_total', { overlap: afterPrints.length > 1 ? 'open' : 'closed' });
  logger.info('SAML IdP certificates changed', { orgId, before: beforePrints.length, after: afterPrints.length });
}

/** The certificates currently trusted, for the before/after comparison above. */
function certsOf(config: OrgIdpConfigDto | null): string[] {
  return config?.samlCertificates ?? [];
}

/** Which route family invoked the operation — recorded on the audit event so the
 *  trail distinguishes an operator acting FOR a customer from the customer's own
 *  admin acting for themselves. */
export type IdpSurface = 'admin' | 'self-service';


/**
 * Refuse an `allowedEmailDomains` entry the org hasn't DNS-verified. The list is
 * a picker over verified domains: a free-text entry proved nothing (the sign-in
 * path already refuses an unverified domain's identities), so storing one only
 * made the settings claim a restriction that could never admit anybody.
 * Returns false when it responded.
 */
async function assertDomainsVerified(res: Response, orgId: string, domains: string[] | undefined): Promise<boolean> {
  if (!domains || domains.length === 0) return true;
  const normalized = domains.map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const missing = await unverifiedDomains(orgId, normalized);
  if (missing.length === 0) return true;
  sendError(
    res, 400,
    `Only verified domains can be allowed. Verify ${missing.join(', ')} under Settings → Domains first.`,
    IDP_DOMAIN_NOT_VERIFIED,
    { domains: missing },
  );
  return false;
}

/** The settings that decide WHICH identity provider (and so which token
 *  endpoint) the client secret is sent to. */
const SECRET_BOUND_FIELDS = ['provider', 'discoveryUrl', 'region', 'userPoolId'] as const;

/**
 * Whether `incoming` moves the connection to a different IdP than `existing`:
 * any secret-bound field present in the body with a different value. An omitted
 * field is "keep" (PATCH semantics); an empty string counts as the field unset.
 */
function retargetsIdp(existing: OrgIdpConfigDto, incoming: Record<string, unknown>): boolean {
  return SECRET_BOUND_FIELDS.some((field) => {
    if (!(field in incoming) || incoming[field] === undefined) return false;
    const next = incoming[field] === '' ? undefined : incoming[field];
    const prev = existing[field] ?? undefined;
    return (prev === '' ? undefined : prev) !== next;
  });
}

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
  // ...but ONLY while it still goes to the same IdP: a change of provider,
  // discovery URL, region or user pool needs the secret re-entered, so a stored
  // secret is never carried to a token endpoint it wasn't entered for.
  if (existing && !body.clientSecret) {
    if (existing.protocol !== 'saml' && body.protocol !== 'saml' && retargetsIdp(existing, body)) {
      throw new Error(IDP_SECRET_REQUIRED);
    }
    const login = await orgIdpService.getLoginConfig(orgId);
    if (login) body.clientSecret = login.clientSecret;
  }

  const parsed = validateBody(orgIdpCreateSchema, body, res);
  if (!parsed) return;
  if (!(await assertDomainsVerified(res, orgId, parsed.allowedEmailDomains))) return;

  const save = async () => {
    const config = await orgIdpService.upsert(req.user!.sub as string, parsed);
    audit(req, 'admin.org-idp.upsert', {
      targetType: 'org-idp-config',
      targetId: orgId,
      affectedOrgId: orgId,
      details: { protocol: config.protocol, provider: config.provider, surface },
    });
    auditCertificateRotation(req, orgId, certsOf(existing), certsOf(config), surface);
    sendSuccess(res, 200, { config });
  };
  // Reserve the `idpConfigs` slot only on a fresh insert; updating an existing
  // config doesn't consume a new one. The per-org unique index caps orgs at one
  // config today, but the quota is in place for the day that relaxes.
  if (existing) await save();
  else await withFeatureQuota(res, orgId, 'idpConfigs', save);
}

/** Partially update an org's IdP config. */
export async function patchOrgIdp(req: Request, res: Response, orgId: string, surface: IdpSurface): Promise<void> {
  const parsed = validateBody(orgIdpPatchSchema, req.body, res);
  if (!parsed) return;
  if (!(await assertDomainsVerified(res, orgId, parsed.allowedEmailDomains))) return;

  // Read the stored config BEFORE the write so a certificate rotation can be
  // told from a save that happened to include the same list, and a policy
  // change from a save that re-sent the same value.
  const existing = await orgIdpService.findByOrg(orgId);
  const before = certsOf(existing);

  // The stored secret follows the connection only while it points at the same
  // IdP (see `upsertOrgIdp`): retargeting it needs the secret re-entered.
  if (existing && existing.protocol !== 'saml' && !parsed.clientSecret
    && retargetsIdp(existing, parsed as Record<string, unknown>)) {
    throw new Error(IDP_SECRET_REQUIRED);
  }

  // "SSO required" governs the org's VERIFIED domains; with none it would
  // govern nobody, so switching it on is refused rather than stored as a no-op.
  if (parsed.ssoRequired === true && !existing?.ssoRequired && !(await hasVerifiedDomain(orgId))) {
    throw new Error(IDP_SSO_REQUIRED_NO_DOMAIN);
  }

  const config = await orgIdpService.patch(orgId, req.user!.sub as string, parsed);
  if (!config) {
    sendError(res, 404, 'IdP config not found for org');
    return;
  }
  audit(req, 'admin.org-idp.upsert', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { protocol: config.protocol, surface },
  });
  auditCertificateRotation(req, orgId, before, certsOf(config), surface);
  if (existing && existing.ssoRequired !== config.ssoRequired) {
    audit(req, 'org.sso.required.update', {
      targetType: 'org-idp-config',
      targetId: orgId,
      affectedOrgId: orgId,
      details: { from: existing.ssoRequired, to: config.ssoRequired, surface },
    });
    incCounter('platform_sso_required_changes_total', { to: config.ssoRequired ? 'on' : 'off' });
  }
  sendSuccess(res, 200, { config });
}

/** Hard-remove an org's IdP config and give back its quota slot. */
export async function deleteOrgIdp(req: Request, res: Response, orgId: string, surface: IdpSurface): Promise<void> {
  const ok = await orgIdpService.delete(orgId);
  if (!ok) {
    sendError(res, 404, 'IdP config not found for org');
    return;
  }

  releaseFeatureQuota(orgId, 'idpConfigs', logger.warn.bind(logger), null);

  audit(req, 'admin.org-idp.delete', {
    targetType: 'org-idp-config',
    targetId: orgId,
    affectedOrgId: orgId,
    details: { surface },
  });
  sendSuccess(res, 200, {});
}
