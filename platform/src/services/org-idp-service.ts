// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Service layer for per-org IdP configuration (scaffolding).
 *
 * Sysadmin-only CRUD. Encrypts `clientSecret` at write via the shared
 * secret-blob helper so the secret never sits in Mongo in clear text.
 * Reads return a sanitized shape that elides the secret entirely.
 *
 * SECRET_ENCRYPTION_KEY is a hard requirement at platform boot — there
 * is no clear-text fallback here; reads of a non-encrypted value throw.
 */

import { createLogger } from '@pipeline-builder/api-core';
import type { OidcLoginConfig } from './oidc-service.js';
import OrgIdpConfig, { type IdpProvider, type OrgIdpConfigDocument } from '../models/org-idp-config.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('org-idp-service');

/** What the API returns. Never includes the secret  clients see a hint only. */
export interface OrgIdpConfigDto {
  orgId: string;
  provider: IdpProvider;
  clientId: string;
  /** True if a secret is on file; false otherwise. The actual value never crosses the wire. */
  hasClientSecret: boolean;
  discoveryUrl?: string;
  /** AWS Cognito region — present only for `provider: 'cognito'`. */
  region?: string;
  /** AWS Cognito user-pool id — present only for `provider: 'cognito'`. */
  userPoolId?: string;
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface OrgIdpConfigCreate {
  orgId: string;
  provider: IdpProvider;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  region?: string;
  userPoolId?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

export interface OrgIdpConfigUpdate {
  provider?: IdpProvider;
  clientId?: string;
  /** Only updated when supplied; an empty body leaves the secret untouched. */
  clientSecret?: string;
  discoveryUrl?: string;
  region?: string;
  userPoolId?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

/** Normalize email domains to lowercase so the login-time domain gate (which
 *  lowercases the caller's email domain) matches regardless of the case an
 *  admin typed. Trims blanks defensively. */
function normalizeDomains(domains?: string[]): string[] {
  return (domains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
}

function toDto(doc: OrgIdpConfigDocument): OrgIdpConfigDto {
  return {
    orgId: doc.orgId,
    provider: doc.provider,
    clientId: doc.clientId,
    hasClientSecret: !!doc.clientSecretEncrypted,
    discoveryUrl: doc.discoveryUrl,
    region: doc.region,
    userPoolId: doc.userPoolId,
    allowedEmailDomains: doc.allowedEmailDomains,
    enabled: doc.enabled,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class OrgIdpService {
  /** List every configured IdP (sysadmin only  across all orgs). */
  async listAll(): Promise<OrgIdpConfigDto[]> {
    const docs = await OrgIdpConfig.find({}).sort({ orgId: 1 });
    return docs.map(toDto);
  }

  /** Read the config for a specific org (sysadmin only). */
  async findByOrg(orgId: string): Promise<OrgIdpConfigDto | null> {
    const doc = await OrgIdpConfig.findOne({ orgId });
    return doc ? toDto(doc): null;
  }

  /** Sysadmin-only  upsert. Per-org unique index means one config per org. */
  async upsert(actor: string, input: OrgIdpConfigCreate): Promise<OrgIdpConfigDto> {
    const existing = await OrgIdpConfig.findOne({ orgId: input.orgId });
    if (existing) {
      existing.provider = input.provider;
      existing.clientId = input.clientId;
      existing.clientSecretEncrypted = wrapEncrypted(input.clientSecret, input.orgId);
      existing.discoveryUrl = input.discoveryUrl;
      existing.region = input.region;
      existing.userPoolId = input.userPoolId;
      existing.allowedEmailDomains = normalizeDomains(input.allowedEmailDomains);
      existing.enabled = input.enabled ?? true;
      existing.updatedBy = actor;
      await existing.save();
      logger.info('OrgIdpConfig updated', { orgId: input.orgId, provider: input.provider });
      return toDto(existing);
    }
    const created = await OrgIdpConfig.create({
      orgId: input.orgId,
      provider: input.provider,
      clientId: input.clientId,
      clientSecretEncrypted: wrapEncrypted(input.clientSecret, input.orgId),
      discoveryUrl: input.discoveryUrl,
      region: input.region,
      userPoolId: input.userPoolId,
      allowedEmailDomains: normalizeDomains(input.allowedEmailDomains),
      enabled: input.enabled ?? true,
      createdBy: actor,
      updatedBy: actor,
    });
    logger.info('OrgIdpConfig created', { orgId: input.orgId, provider: input.provider });
    return toDto(created);
  }

  /** Patch  only fields provided are updated. clientSecret omitted leaves
   * the existing encrypted blob untouched. */
  async patch(orgId: string, actor: string, input: OrgIdpConfigUpdate): Promise<OrgIdpConfigDto | null> {
    const existing = await OrgIdpConfig.findOne({ orgId });
    if (!existing) return null;

    if (input.provider !== undefined) existing.provider = input.provider;
    if (input.clientId !== undefined) existing.clientId = input.clientId;
    if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
      existing.clientSecretEncrypted = wrapEncrypted(input.clientSecret, orgId);
    }
    if (input.discoveryUrl !== undefined) existing.discoveryUrl = input.discoveryUrl;
    if (input.region !== undefined) existing.region = input.region;
    if (input.userPoolId !== undefined) existing.userPoolId = input.userPoolId;
    if (input.allowedEmailDomains !== undefined) existing.allowedEmailDomains = normalizeDomains(input.allowedEmailDomains);
    if (input.enabled !== undefined) existing.enabled = input.enabled;
    existing.updatedBy = actor;
    await existing.save();
    return toDto(existing);
  }

  /** Hard delete  IdP config has no audit-history requirement that a
   * soft-delete would serve. The audit event in the controller records
   * the action; the row itself isn't useful tombstoned. */
  async delete(orgId: string): Promise<boolean> {
    const res = await OrgIdpConfig.deleteOne({ orgId });
    return (res.deletedCount ?? 0) > 0;
  }

  /**
   * INTERNAL LOGIN PATH ONLY — full config including the DECRYPTED
   * `clientSecret`. This is the one place the plaintext is materialized, for
   * the server-side OIDC token exchange; it is NEVER returned through any CRUD
   * DTO (which expose only `hasClientSecret`) and the secret is never logged.
   * Returns `enabled` so the enforcement layer decides whether to honor it.
   * Returns null when the org has no config.
   */
  async getLoginConfig(orgId: string): Promise<(OidcLoginConfig & { enabled: boolean }) | null> {
    const doc = await OrgIdpConfig.findOne({ orgId });
    if (!doc) return null;
    const clientSecret = unwrapEncrypted(doc.clientSecretEncrypted, doc.orgId, 'org-idp.clientSecret');
    return {
      orgId: doc.orgId,
      provider: doc.provider,
      clientId: doc.clientId,
      clientSecret,
      discoveryUrl: doc.discoveryUrl ?? '',
      region: doc.region,
      userPoolId: doc.userPoolId,
      allowedEmailDomains: doc.allowedEmailDomains ?? [],
      enabled: doc.enabled,
    };
  }

  /**
   * Enabled configs whose `allowedEmailDomains` cover `domain` (matched
   * case-insensitively). Used by password-login domain gating to force covered
   * users through SSO. Returns only the orgIds — the enforcement layer resolves
   * the login config + verifies the `sso` entitlement per candidate.
   */
  async findEnabledOrgIdsByDomain(domain: string): Promise<string[]> {
    const needle = domain.toLowerCase();
    const docs = await OrgIdpConfig.find({
      enabled: true,
      allowedEmailDomains: needle,
    }).select('orgId').lean();
    return docs.map((d) => String(d.orgId));
  }

}

export const orgIdpService = new OrgIdpService();
