// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Service layer for per-org IdP configuration (scaffolding).
 *
 * Sysadmin-only CRUD. Encrypts `clientSecret` at write via api-core's
 * envelope encryption primitive so the secret never sits in Mongo in
 * clear text. Reads return a sanitized shape that elides the secret;
 * `getDecryptedSecret` is the explicit decrypt path for the OIDC
 * dispatcher.
 *
 * SECRET_ENCRYPTION_KEY is a hard requirement at platform boot — there
 * is no clear-text fallback here. The startup backfill re-encrypts any
 * pre-encryption rows.
 */

import { createLogger, decryptSecret, encryptSecret, isEncryptedBlob } from '@pipeline-builder/api-core';
import type { EncryptedBlob } from '@pipeline-builder/api-core';
import OrgIdpConfig, { type IdpProvider, type OrgIdpConfigDocument } from '../models/org-idp-config';

const logger = createLogger('org-idp-service');

/** What the API returns. Never includes the secret  clients see a hint only. */
export interface OrgIdpConfigDto {
  orgId: string;
  provider: IdpProvider;
  clientId: string;
  /** True if a secret is on file; false otherwise. The actual value never crosses the wire. */
  hasClientSecret: boolean;
  discoveryUrl?: string;
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
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

export interface OrgIdpConfigUpdate {
  provider?: IdpProvider;
  clientId?: string;
  /** Only updated when supplied; an empty body leaves the secret untouched. */
  clientSecret?: string;
  discoveryUrl?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

/** Encrypt for storage. `SECRET_ENCRYPTION_KEY` is required at boot so
 *  this never falls back to clear text. */
function encryptForStorage(plaintext: string, orgId: string): string {
  return JSON.stringify(encryptSecret(plaintext, orgId));
}

/** Decrypt a stored client-secret blob. Throws when the value isn't a
 *  well-formed EncryptedBlob — surfacing a corrupt row beats serving stale
 *  clear-text plaintext masquerading as a "configured" secret. */
function decryptStoredBlob(raw: string, orgId: string): string {
  if (!raw.startsWith('{')) {
    throw new Error('Stored IdP client secret is not a JSON-encoded EncryptedBlob');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Stored IdP client secret is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isEncryptedBlob(parsed)) {
    throw new Error('Stored IdP client secret does not match the EncryptedBlob shape');
  }
  return decryptSecret(parsed as EncryptedBlob, orgId);
}

function toDto(doc: OrgIdpConfigDocument): OrgIdpConfigDto {
  return {
    orgId: doc.orgId,
    provider: doc.provider,
    clientId: doc.clientId,
    hasClientSecret: !!doc.clientSecretEncrypted,
    discoveryUrl: doc.discoveryUrl,
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
      existing.clientSecretEncrypted = encryptForStorage(input.clientSecret, input.orgId);
      existing.discoveryUrl = input.discoveryUrl;
      existing.allowedEmailDomains = input.allowedEmailDomains ?? [];
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
      clientSecretEncrypted: encryptForStorage(input.clientSecret, input.orgId),
      discoveryUrl: input.discoveryUrl,
      allowedEmailDomains: input.allowedEmailDomains ?? [],
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
      existing.clientSecretEncrypted = encryptForStorage(input.clientSecret, orgId);
    }
    if (input.discoveryUrl !== undefined) existing.discoveryUrl = input.discoveryUrl;
    if (input.allowedEmailDomains !== undefined) existing.allowedEmailDomains = input.allowedEmailDomains;
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
   * Decrypt path for the FUTURE OIDC dispatcher. The current platform has
   * no caller; this lives here so the dispatcher can land in a follow-up
   * with a one-line service call rather than re-implementing the decrypt.
   *
   * Throws on alg mismatch / tampered blob  the dispatcher should treat
   * a throw as "SSO unavailable for this org" and fall through to the
   * existing password / OAuth login UI.
   */
  async getDecryptedSecret(orgId: string): Promise<string | null> {
    const doc = await OrgIdpConfig.findOne({ orgId }).select('clientSecretEncrypted');
    if (!doc?.clientSecretEncrypted) return null;
    return decryptStoredBlob(doc.clientSecretEncrypted, orgId);
  }
}

export const orgIdpService = new OrgIdpService();
