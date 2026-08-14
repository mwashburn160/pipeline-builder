// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSO enforcement policy — the glue that decides WHEN the per-org OIDC engine
 * (services/oidc-service.ts) actually governs a login.
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

import { resolveUserFeatures } from '@pipeline-builder/api-core';
import { resolveOrgLineage } from './org-hierarchy.js';
import { toOrgId } from './org-id.js';
import { Organization } from '../models/index.js';
import type { OidcLoginConfig } from '../services/oidc-service.js';
import { orgIdpService } from '../services/org-idp-service.js';

/** Extract the lowercased domain from an email, or null if it isn't one. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
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
 * Resolve the ENFORCED OIDC login config for an org, or throw a typed
 * {@link import('../services/oidc-service.js').OIDC_ERROR_MAP} error describing
 * why enforcement doesn't apply. Used by the SSO initiate + callback routes.
 */
export async function getEnforcedLoginConfig(orgId: string): Promise<OidcLoginConfig> {
  const cfg = await orgIdpService.getLoginConfig(orgId);
  if (!cfg) throw new Error('OIDC_NOT_CONFIGURED');
  if (!cfg.enabled) throw new Error('OIDC_DISABLED');
  if (!(await isSsoEntitled(orgId))) throw new Error('OIDC_NOT_ENTITLED');
  // Strip the `enabled` flag — the login config carries only what the flow uses.
  const { enabled: _enabled, ...loginCfg } = cfg;
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
): Promise<{ orgId: string; provider: string } | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  const candidateOrgIds = await orgIdpService.findEnabledOrgIdsByDomain(domain);
  for (const orgId of candidateOrgIds) {
    if (await isSsoEntitled(orgId)) {
      const cfg = await orgIdpService.findByOrg(orgId);
      return { orgId, provider: cfg?.provider ?? 'generic-oidc' };
    }
  }
  return null;
}
