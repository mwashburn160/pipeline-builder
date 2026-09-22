// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO enforcement policy — the glue that decides WHEN a per-org federation
 * engine (services/oidc-service.ts, services/saml-service.ts) actually governs a
 * login. The gates are protocol-independent on purpose: SAML ships INSIDE the
 * existing `sso` entitlement, so nothing about "may this org federate?" changes
 * when an admin moves the protocol selector.
 *
 * Two independent gates must BOTH hold for enforcement:
 *   1. `config.enabled` on the org's OrgIdpConfig (the admin turned SSO on), AND
 *   2. the org is `sso`-ENTITLED (Team/Enterprise tier, or an `sso` account
 *      feature-entitlement bundle) — resolved the same drift-proof way tokens
 *      resolve entitlements: a parented team reads its ROOT's entitlements.
 *
 * A config that is disabled OR unentitled is a NO-OP: password login proceeds
 * and the SSO initiate/callback routes refuse. This keeps a half-configured or
 * downgraded org from silently locking every user out.
 *
 * On top of those, REFUSING the other sign-in methods is a separate, explicit
 * org policy — "SSO required" (`OrgIdpConfig.ssoRequired`, #5). An enabled IdP
 * without it OFFERS single sign-on to its verified domains; with it, people in
 * those domains can sign in no other way — except the org's OWNERS, who always
 * keep their own password / passkey / social sign-in as the break-glass path.
 */

import { resolveUserFeatures, sendError } from '@pipeline-builder/api-core';
import type { Types } from 'mongoose';
import { requireOrgScope } from './controller-helper.js';
import { resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { GOOGLE_ISSUER } from './reserved-issuers.js';
import { OrgDomain, Organization, User, UserOrganization } from '../models/index.js';
import type { IdpProtocol } from '../models/org-idp-config.js';
import type { OidcLoginConfig } from '../services/oidc-service.js';
import { orgIdpService } from '../services/org-idp-service.js';
import type { SamlLoginConfig } from '../services/saml-service.js';

/** Extract the lowercased domain from an email, or null if it isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/** Google is the authority for every address it signs in — no org can mint a
 *  Google identity — so its `email_verified` is trusted as-is. Every other IdP
 *  (generic OIDC, Cognito, SAML) is run by the org's own admin, who can assert
 *  any email as verified. Re-exported from the pure reserved-issuer module. */
export { GOOGLE_ISSUER };

/**
 * Whether `orgId` — or the account root it belongs to — has proven ownership of
 * `domain` through the DNS challenge. This is what makes an org's say-so about an
 * address trustworthy; the free-text `allowedEmailDomains` list proves nothing.
 * If the lineage can't be read, only the org's own domains count (fail closed).
 */
export async function ownsVerifiedDomain(orgId: string, domain: string): Promise<boolean> {
  const owners = [orgId];
  try {
    const { rootOrgId } = await resolveOrgLineage(orgId);
    if (rootOrgId !== orgId) owners.push(rootOrgId);
  } catch {
    // Own domains only.
  }
  return !!(await OrgDomain.exists({ domain: domain.toLowerCase(), verified: true, orgId: { $in: owners } }));
}

/** Where a verified SSO identity came from. The Google carve-out is decided
 *  from THIS — the platform-controlled route the identity arrived by — never
 *  from the identity's `issuer` alone, which an admin-run IdP controls (a
 *  generic OIDC discovery document or a SAML entity id can claim to be Google). */
export type SsoIdentitySource =
  | { protocol: 'oidc'; provider: string }
  | { protocol: 'saml' };

/**
 * Refuse an SSO identity the org has no authority over. An admin-run IdP can
 * sign any email as verified, so unless the identity came from Google — the
 * `google` OIDC provider, whose discovery document is hard-coded, AND Google's
 * issuer — the email's domain must be one the org has verified. Otherwise one
 * org could sign in as (or link onto) any other account on the platform by email.
 */
export async function assertSsoIdentityTrusted(
  orgId: string,
  identity: { issuer: string; email: string },
  source: SsoIdentitySource,
): Promise<void> {
  const fromGoogle = source.protocol === 'oidc'
    && source.provider === 'google'
    && identity.issuer === GOOGLE_ISSUER;
  if (fromGoogle) return;
  const domain = emailDomain(identity.email);
  if (!domain || !(await ownsVerifiedDomain(orgId, domain))) {
    throw new Error('OIDC_EMAIL_DOMAIN_NOT_VERIFIED');
  }
}

/**
 * Whether `orgId` is entitled to the `sso` feature. Reads the org's tier +
 * account feature-entitlements; for a parented team the entitlements POOL at the
 * account root, so we read them from the root (mirrors token issuance's
 * `accountContext`). A soft-deleted org is treated as not entitled.
 */
export async function isSsoEntitled(orgId: string): Promise<boolean> {
  const org = await Organization.findById(toOrgId(orgId))
    .select('tier featureEntitlements parentOrgId deletedAt').lean();
  if (!org || (org as { deletedAt?: Date | null }).deletedAt) return false;

  let accountFeatures = (org as { featureEntitlements?: string[] }).featureEntitlements ?? [];
  if ((org as { parentOrgId?: string | null }).parentOrgId) {
    try {
      const { rootOrgId } = await resolveOrgLineage(orgId);
      const root = await Organization.findById(toOrgId(rootOrgId)).select('featureEntitlements').lean();
      accountFeatures = (root as { featureEntitlements?: string[] })?.featureEntitlements ?? accountFeatures;
    } catch {
      // Degrade to the team-doc copy (same choice token issuance makes).
    }
  }

  const features = resolveUserFeatures((org as { tier: 'developer' | 'pro' | 'team' | 'enterprise' | 'unlimited' }).tier, { accountFeatures });
  return features.includes('sso');
}

/**
 * Shared tenancy + entitlement gate for every org-facing SSO surface (the IdP
 * config editor and the group-mapping editor). Confirms the caller may manage
 * `orgId` — their own org or a team they administer — AND that the org is
 * `sso`-entitled, which is what makes JIT and mapping part of SSO rather than a
 * separate add-on. Returns false (having already responded) when either fails.
 */
export async function requireOwnOrgSso(
  req: Parameters<typeof requireOrgScope>[0],
  res: Parameters<typeof requireOrgScope>[1],
  orgId: string,
): Promise<boolean> {
  if (!(await requireOrgScope(req, res, orgId))) return false;
  if (!(await isSsoEntitled(orgId))) {
    sendError(res, 403, 'This organization is not entitled to SSO', 'SSO_NOT_ENTITLED');
    return false;
  }
  return true;
}

/**
 * Which protocol an org's ENFORCED IdP speaks (#4), or a typed
 * {@link import('../services/oidc-service.js').OIDC_ERROR_MAP} error describing
 * why enforcement doesn't apply at all. The two protocol-specific resolvers
 * below re-check the same gates, so this is the DISPATCH, never the gate.
 */
export async function getEnforcedIdpProtocol(orgId: string): Promise<IdpProtocol> {
  const cfg = await orgIdpService.findByOrg(orgId);
  if (!cfg) throw new Error('OIDC_NOT_CONFIGURED');
  if (!cfg.enabled) throw new Error('OIDC_DISABLED');
  if (!(await isSsoEntitled(orgId))) throw new Error('OIDC_NOT_ENTITLED');
  return cfg.protocol;
}

/**
 * Resolve the ENFORCED OIDC login config for an org, or throw a typed
 * {@link import('../services/oidc-service.js').OIDC_ERROR_MAP} error describing
 * why enforcement doesn't apply. Used by the SSO initiate + callback routes.
 *
 * An org federating over SAML is refused here (`OIDC_PROTOCOL_MISMATCH`) rather
 * than handed a config with an empty client id: the caller wants the OIDC flow,
 * and this org does not speak it.
 */
export async function getEnforcedLoginConfig(orgId: string): Promise<OidcLoginConfig> {
  const cfg = await orgIdpService.getLoginConfig(orgId);
  if (!cfg) throw new Error('OIDC_NOT_CONFIGURED');
  if (!cfg.enabled) throw new Error('OIDC_DISABLED');
  if (!(await isSsoEntitled(orgId))) throw new Error('OIDC_NOT_ENTITLED');
  if (cfg.protocol === 'saml') throw new Error('OIDC_PROTOCOL_MISMATCH');
  // Strip the flags — the login config carries only what the flow uses.
  const { enabled: _enabled, protocol: _protocol, ...loginCfg } = cfg;
  return loginCfg;
}

/**
 * Resolve the ENFORCED SAML login config for an org, or throw a typed
 * {@link import('../services/saml-service.js').SAML_ERROR_MAP} error. The SAML
 * twin of {@link getEnforcedLoginConfig}: the SAME two gates (the admin enabled
 * SSO, and the org is `sso`-entitled) decide both protocols, because SAML ships
 * inside the existing SSO entitlement rather than as an add-on of its own.
 */
export async function getEnforcedSamlConfig(orgId: string): Promise<SamlLoginConfig> {
  const cfg = await orgIdpService.getSamlLoginConfig(orgId);
  if (!cfg) throw new Error('SAML_NOT_CONFIGURED');
  if (cfg.protocol !== 'saml') throw new Error('SAML_PROTOCOL_MISMATCH');
  if (!cfg.enabled) throw new Error('SAML_DISABLED');
  if (!(await isSsoEntitled(orgId))) throw new Error('SAML_NOT_ENTITLED');
  const { enabled: _enabled, protocol: _protocol, ...loginCfg } = cfg;
  return loginCfg;
}

/**
 * The OIDC config for a DRY RUN (test connection) — the enforced resolver
 * minus the `enabled` gate, because a connection must be testable BEFORE it is
 * switched on (that is the point of testing it). Entitlement still applies.
 */
export async function getTestableLoginConfig(orgId: string): Promise<OidcLoginConfig> {
  const cfg = await orgIdpService.getLoginConfig(orgId);
  if (!cfg) throw new Error('OIDC_NOT_CONFIGURED');
  if (!(await isSsoEntitled(orgId))) throw new Error('OIDC_NOT_ENTITLED');
  if (cfg.protocol === 'saml') throw new Error('OIDC_PROTOCOL_MISMATCH');
  const { enabled: _enabled, protocol: _protocol, ...loginCfg } = cfg;
  return loginCfg;
}

/** The SAML twin of {@link getTestableLoginConfig}. */
export async function getTestableSamlConfig(orgId: string): Promise<SamlLoginConfig> {
  const cfg = await orgIdpService.getSamlLoginConfig(orgId);
  if (!cfg) throw new Error('SAML_NOT_CONFIGURED');
  if (cfg.protocol !== 'saml') throw new Error('SAML_PROTOCOL_MISMATCH');
  if (!(await isSsoEntitled(orgId))) throw new Error('SAML_NOT_ENTITLED');
  const { enabled: _enabled, protocol: _protocol, ...loginCfg } = cfg;
  return loginCfg;
}

/**
 * The SAML config a Single Logout message is verified against. Deliberately
 * gated on nothing but "a SAML connection exists": ending sessions is always
 * safe, and an IdP must still be able to sign people out of an org that has
 * just disabled SSO or lost its entitlement.
 */
export async function getSamlConfigForLogout(orgId: string): Promise<SamlLoginConfig> {
  const cfg = await orgIdpService.getSamlLoginConfig(orgId);
  if (!cfg) throw new Error('SAML_NOT_CONFIGURED');
  if (cfg.protocol !== 'saml') throw new Error('SAML_PROTOCOL_MISMATCH');
  const { enabled: _enabled, protocol: _protocol, ...loginCfg } = cfg;
  return loginCfg;
}

/** The org whose SSO covers an email's domain (see {@link findSsoCoverageForEmail}). */
export interface SsoCoverage {
  orgId: string;
  /** What the client shows ("Continue with …") — `saml` for a SAML IdP. */
  provider: string;
  protocol: IdpProtocol;
  /** The org's "SSO required" policy is on for this domain. */
  required: boolean;
}

/** The org that DNS-verified `domain` (a verified domain belongs to exactly one). */
async function verifiedDomainOwner(domain: string): Promise<string | null> {
  const row = await OrgDomain.findOne({ domain, verified: true }).select('orgId').lean();
  return row ? String((row as { orgId: string }).orgId) : null;
}

/**
 * DOMAIN-level SSO coverage: the org whose ENABLED + `sso`-ENTITLED IdP serves
 * `email`'s domain, or null. "Serves" means the org (or its account root) has
 * DNS-VERIFIED the domain AND, when the IdP pins `allowedEmailDomains`, the
 * domain is on that list. `required` reports the org's "SSO required" policy.
 *
 * Said about the DOMAIN, never the address — so it is safe to answer for an
 * anonymous caller in a bare yes/no (discover), and it is what lets the login
 * page offer "Continue with single sign-on" to an org that has SSO without
 * requiring it. A config that forces SSO wins over one that merely offers it.
 */
export async function findSsoCoverageForEmail(email: string): Promise<SsoCoverage | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  const owner = await verifiedDomainOwner(domain);
  const candidates = await orgIdpService.findEnabledCandidatesForDomain(domain, owner ? [owner] : []);
  candidates.sort((a, b) => Number(b.ssoRequired) - Number(a.ssoRequired));
  for (const c of candidates) {
    const allowed = c.allowedEmailDomains.map((d) => d.toLowerCase());
    if (allowed.length > 0 && !allowed.includes(domain)) continue;
    // Only a domain the org has VERIFIED counts — otherwise any org could list
    // `gmail.com` and capture (or lock out) every Gmail user.
    if (!(await ownsVerifiedDomain(c.orgId, domain))) continue;
    if (!(await isSsoEntitled(c.orgId))) continue;
    return {
      orgId: c.orgId,
      protocol: c.protocol,
      provider: c.protocol === 'saml' ? 'saml' : (c.provider ?? 'generic-oidc'),
      required: c.ssoRequired,
    };
  }
  return null;
}

/**
 * Whether the account at `email` OWNS `orgId` (or its account root) — the
 * "SSO required" break-glass. An owner can always sign in with their own
 * password / passkey / social login, so a broken IdP, an expired certificate or
 * a mis-set policy can never lock the organization out of fixing it.
 */
async function isOwnerOfOrgByEmail(orgId: string, email: string): Promise<boolean> {
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select('_id').lean<{ _id: Types.ObjectId }>();
  if (!user) return false;
  const orgIds = [orgId];
  try {
    const { rootOrgId } = await resolveOrgLineage(orgId);
    if (rootOrgId !== orgId) orgIds.push(rootOrgId);
  } catch {
    // Own org only.
  }
  return !!(await UserOrganization.exists({
    userId: user._id,
    organizationId: { $in: orgIds.map(toOrgId) },
    role: 'owner',
    isActive: true,
  }));
}

/**
 * The org whose "SSO required" policy GOVERNS `email`, or null. This is what
 * turns away every non-SSO sign-in (password, passkey, social, TOTP) and what
 * the re-auth/TOTP surfaces consult.
 *
 * Null when the domain has no covering IdP, when the covering org has not
 * switched "SSO required" on, or when the account is an OWNER of that org — the
 * break-glass rule: owners are exempt, always.
 */
export async function findSsoEnforcementForEmail(
  email: string,
): Promise<{ orgId: string; provider: string; protocol: IdpProtocol } | null> {
  const coverage = await findSsoCoverageForEmail(email);
  if (!coverage?.required) return null;
  if (await isOwnerOfOrgByEmail(coverage.orgId, email)) return null;
  return { orgId: coverage.orgId, provider: coverage.provider, protocol: coverage.protocol };
}

/**
 * Domains in `domains` that `orgId` (or its account root) has NOT verified. The
 * IdP write path refuses an `allowedEmailDomains` entry the org can't vouch for:
 * the list is a picker over verified domains, not free text.
 */
export async function unverifiedDomains(orgId: string, domains: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of domains) {
    if (!(await ownsVerifiedDomain(orgId, d))) out.push(d);
  }
  return out;
}

/** Whether `orgId` (or its account root) has any DNS-verified domain. */
export async function hasVerifiedDomain(orgId: string): Promise<boolean> {
  const owners = [orgId];
  try {
    const { rootOrgId } = await resolveOrgLineage(orgId);
    if (rootOrgId !== orgId) owners.push(rootOrgId);
  } catch {
    // Own domains only.
  }
  return !!(await OrgDomain.exists({ verified: true, orgId: { $in: owners } }));
}

/**
 * Reject a login when `email` is governed by an org's "SSO required" policy —
 * those people MUST authenticate through the org's IdP, so ANY non-SSO sign-in
 * (password, passkey, social OAuth) is a bypass. Returns `true` when it handled
 * (rejected) the request; the caller must then return without issuing a session.
 *
 * `details.orgId`/`provider`/`protocol` let the frontend start the SSO flow
 * straight away. Owners are exempt (see {@link findSsoEnforcementForEmail}), and
 * a disabled / unentitled / not-required config never matches. Shared by the
 * password, passkey and TOTP sign-in controllers and the social-OAuth callback,
 * so all of them close the same bypass identically.
 */
export async function rejectIfSsoEnforced(
  res: Parameters<typeof sendError>[0],
  email: string,
): Promise<boolean> {
  const enforcement = await findSsoEnforcementForEmail(email);
  if (!enforcement) return false;
  sendError(
    res, 403,
    'Your organization requires single sign-on (SSO). Continue with your organization\'s identity provider instead.',
    'SSO_REQUIRED',
    { orgId: enforcement.orgId, provider: enforcement.provider, protocol: enforcement.protocol },
  );
  return true;
}
