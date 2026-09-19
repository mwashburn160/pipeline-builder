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
 */

import { resolveUserFeatures, sendError } from '@pipeline-builder/api-core';
import { requireOrgScope } from './controller-helper.js';
import { resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { OrgDomain, Organization } from '../models/index.js';
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
 *  (generic OIDC, Cognito) is run by the org's own admin, who can assert any
 *  email as verified. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

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

/**
 * Refuse an SSO identity the org has no authority over. An admin-run IdP can
 * sign any email as verified, so unless the IdP is Google the email's domain
 * must be one the org has verified — otherwise one org could sign in as (or link
 * onto) any other account on the platform by email.
 */
export async function assertSsoIdentityTrusted(
  orgId: string,
  identity: { issuer: string; email: string },
): Promise<void> {
  if (identity.issuer === GOOGLE_ISSUER) return;
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
 * Find the org whose ENABLED + ENTITLED IdP enforces SSO for `email`'s domain,
 * or null when none does. Drives password-login domain gating: a covered user
 * must be turned away from the password endpoint and sent through SSO.
 *
 * Returns just the identifying bits (orgId + provider) — enough for the caller
 * to tell the client which org to initiate SSO against; it deliberately does
 * NOT materialize the decrypted secret.
 */
export async function findSsoEnforcementForEmail(
  email: string,
): Promise<{ orgId: string; provider: string; protocol: IdpProtocol } | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  const candidateOrgIds = await orgIdpService.findEnabledOrgIdsByDomain(domain);
  for (const orgId of candidateOrgIds) {
    // Only a domain the org has VERIFIED may force its users through SSO —
    // otherwise any org could list `gmail.com` and lock every Gmail user out of
    // password and social login.
    if (!(await ownsVerifiedDomain(orgId, domain))) continue;
    if (await isSsoEntitled(orgId)) {
      const cfg = await orgIdpService.findByOrg(orgId);
      const protocol = cfg?.protocol ?? 'oidc';
      // `provider` is what the client shows the user ("Continue with …"); a SAML
      // config has no named provider, so it identifies itself by its protocol.
      return { orgId, protocol, provider: protocol === 'saml' ? 'saml' : (cfg?.provider ?? 'generic-oidc') };
    }
  }
  return null;
}

/**
 * Reject a login when `email`'s domain is covered by an ENABLED + `sso`-entitled
 * org IdP — those users MUST authenticate through SSO, so ANY non-SSO login
 * (password OR social OAuth) is a bypass. Returns `true` when it handled
 * (rejected) the request; the caller must then return without issuing a session.
 *
 * `details.orgId`/`provider` let the frontend route the user straight into the
 * SSO initiate flow. A disabled/unentitled config never matches, so this is a
 * no-op until an admin enables SSO. Shared by the password-login controller
 * (controllers/auth.ts) and the social-OAuth callback (controllers/oauth.ts) so
 * both close the same bypass identically.
 */
export async function rejectIfSsoEnforced(
  res: Parameters<typeof sendError>[0],
  email: string,
): Promise<boolean> {
  const enforcement = await findSsoEnforcementForEmail(email);
  if (!enforcement) return false;
  sendError(
    res, 403,
    'This account must sign in with single sign-on (SSO).',
    'SSO_REQUIRED',
    { orgId: enforcement.orgId, provider: enforcement.provider, protocol: enforcement.protocol },
  );
  return true;
}
