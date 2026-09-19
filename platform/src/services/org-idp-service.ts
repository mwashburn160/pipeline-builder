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
 *
 * One document, two protocols (#4): `protocol` selects OIDC or SAML, and the
 * per-protocol completeness rule (`assertProtocolComplete`) is enforced on the
 * RESULTING document, so a half-entered protocol switch is refused rather than
 * saved and discovered at somebody's next sign-in. A SAML config carries no
 * client secret at all — its trust is the IdP's signing certificate.
 */

import { createLogger } from '@pipeline-builder/api-core';
import { IDP_OIDC_INCOMPLETE, IDP_SAML_INCOMPLETE, IGM_PROVIDER_UNSUPPORTED } from './idp-mapping-errors.js';
import type { OidcLoginConfig } from './oidc-service.js';
import { type SamlLoginConfig, samlAcsUrl, samlSpEntityId } from './saml-service.js';
import { providerSupportsGroups } from '../helpers/idp-claims.js';
import OrgIdpConfig, {
  type IdpProtocol,
  type IdpProvider,
  type OrgIdpConfigDocument,
  type SamlAttributeMapping,
} from '../models/org-idp-config.js';
import { unwrapEncrypted, wrapEncrypted } from '../utils/secret-blob.js';

const logger = createLogger('org-idp-service');

/** What the API returns. Never includes the secret  clients see a hint only. */
export interface OrgIdpConfigDto {
  orgId: string;
  /** Which protocol this org federates over (#4). */
  protocol: IdpProtocol;
  /** OIDC only — absent on a SAML config. */
  provider?: IdpProvider;
  clientId?: string;
  /** True if a secret is on file; false otherwise. The actual value never crosses the wire. */
  hasClientSecret: boolean;
  /** SAML: the IdP's entity id (its `Issuer`). */
  samlEntityId?: string;
  /** SAML: the IdP's SSO endpoint (HTTP-Redirect binding). */
  samlSsoUrl?: string;
  /** SAML: the trusted IdP signing certificates. More than one during a
   *  rotation window. Public certificates — safe to return. */
  samlCertificates: string[];
  /** SAML: per-org attribute names for email / name / groups. */
  samlAttributes?: SamlAttributeMapping;
  /** SAML: the service-provider values an IdP administrator needs. Derived, not
   *  stored — returned so the settings page can show them without a second call. */
  samlSp?: { entityId: string; acsUrl: string; metadataUrl: string };
  discoveryUrl?: string;
  /** AWS Cognito region — present only for `provider: 'cognito'`. */
  region?: string;
  /** AWS Cognito user-pool id — present only for `provider: 'cognito'`. */
  userPoolId?: string;
  /** id_token claim carrying group memberships for JIT Role mapping (3a).
   *  Absent = the `groups` default; never set for Google (no group claims). */
  groupsClaim?: string;
  allowedEmailDomains: string[];
  enabled: boolean;
  updatedAt: string;
}

export interface OrgIdpConfigCreate {
  orgId: string;
  /** Omitted leaves an existing config's protocol alone (and means `oidc` on a
   *  fresh create) — the OIDC editor doesn't know about the selector. */
  protocol?: IdpProtocol;
  provider?: IdpProvider;
  clientId?: string;
  clientSecret?: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlCertificates?: string[];
  samlAttributes?: SamlAttributeMapping;
  discoveryUrl?: string;
  region?: string;
  userPoolId?: string;
  groupsClaim?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

export interface OrgIdpConfigUpdate {
  protocol?: IdpProtocol;
  provider?: IdpProvider;
  clientId?: string;
  /** Only updated when supplied; an empty body leaves the secret untouched. */
  clientSecret?: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlCertificates?: string[];
  samlAttributes?: SamlAttributeMapping;
  discoveryUrl?: string;
  region?: string;
  userPoolId?: string;
  groupsClaim?: string;
  allowedEmailDomains?: string[];
  enabled?: boolean;
}

/** Normalize email domains to lowercase so the login-time domain gate (which
 *  lowercases the caller's email domain) matches regardless of the case an
 *  admin typed. Trims blanks defensively. */
function normalizeDomains(domains?: string[]): string[] {
  return (domains ?? []).map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
}

/**
 * Normalize + AUTHORIZE a `groupsClaim` for `provider`.
 *
 * A blank value means "use the default", stored as unset. A value on a provider
 * that issues no group claims (Google) is REFUSED with `IGM_PROVIDER_UNSUPPORTED`
 * rather than quietly accepted — the admin would otherwise author a mapping set
 * that can never match, and only find out when nobody gets their Roles.
 *
 * `provider: undefined` means SAML, which has no named provider: its groups come
 * from a mapped ASSERTION ATTRIBUTE (`samlAttributes.groups`), so the Google
 * carve-out has nothing to say about it and the claim is left as given.
 */
function normalizeGroupsClaim(provider: IdpProvider | undefined, claim: string | undefined): string | undefined {
  const trimmed = claim?.trim();
  if (!trimmed) return undefined;
  if (provider && !providerSupportsGroups(provider)) throw new Error(IGM_PROVIDER_UNSUPPORTED);
  return trimmed;
}

/**
 * Normalize the IdP signing certificates an admin pasted.
 *
 * IdP consoles hand these out in every shape: full PEM, bare base64, with CRLF,
 * with stray indentation. node-saml accepts PEM or base64 but nothing in
 * between, so trim each entry, drop blanks, and de-duplicate — a rotation list
 * holding the same certificate twice is an operator mistake that would otherwise
 * look like a live overlap window.
 */
function normalizeCertificates(certs?: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of certs ?? []) {
    const trimmed = (raw ?? '').replace(/\r\n/g, '\n').trim();
    if (!trimmed) continue;
    // Compare on the base64 payload so PEM-wrapped and bare copies of one
    // certificate are recognized as the same certificate.
    const key = trimmed.replace(/-----(BEGIN|END)[A-Z ]+-----/g, '').replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Drop blank attribute names so "unset" and "empty string" mean one thing. */
function normalizeSamlAttributes(attrs?: SamlAttributeMapping): SamlAttributeMapping | undefined {
  if (!attrs) return undefined;
  const out: SamlAttributeMapping = {};
  if (attrs.email?.trim()) out.email = attrs.email.trim();
  if (attrs.name?.trim()) out.name = attrs.name.trim();
  if (attrs.groups?.trim()) out.groups = attrs.groups.trim();
  return out;
}

/**
 * Refuse a config that could never sign anyone in.
 *
 * Mongoose cannot express "required when `protocol` has this value", so the
 * per-protocol completeness rule lives here, applied to the RESULTING document —
 * which is what makes a protocol switch fail loudly instead of leaving an org
 * with SAML selected and no IdP to talk to.
 */
function assertProtocolComplete(doc: Pick<OrgIdpConfigDocument,
'protocol' | 'provider' | 'clientId' | 'clientSecretEncrypted' | 'samlEntityId' | 'samlSsoUrl' | 'samlCertificates'>): void {
  if (doc.protocol === 'saml') {
    if (!doc.samlEntityId || !doc.samlSsoUrl || (doc.samlCertificates ?? []).length === 0) {
      throw new Error(IDP_SAML_INCOMPLETE);
    }
    return;
  }
  if (!doc.provider || !doc.clientId || !doc.clientSecretEncrypted) {
    throw new Error(IDP_OIDC_INCOMPLETE);
  }
}

function toDto(doc: OrgIdpConfigDocument): OrgIdpConfigDto {
  const protocol = doc.protocol ?? 'oidc';
  return {
    orgId: doc.orgId,
    protocol,
    provider: doc.provider,
    clientId: doc.clientId,
    hasClientSecret: !!doc.clientSecretEncrypted,
    samlEntityId: doc.samlEntityId,
    samlSsoUrl: doc.samlSsoUrl,
    samlCertificates: doc.samlCertificates ?? [],
    samlAttributes: doc.samlAttributes,
    // Always present: an admin needs the SP values to configure their IdP BEFORE
    // the connection works, so they can't be conditional on it working.
    samlSp: {
      entityId: samlSpEntityId(doc.orgId),
      acsUrl: samlAcsUrl(doc.orgId),
      metadataUrl: samlSpEntityId(doc.orgId),
    },
    discoveryUrl: doc.discoveryUrl,
    region: doc.region,
    userPoolId: doc.userPoolId,
    groupsClaim: doc.groupsClaim,
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

  /**
   * Upsert. Per-org unique index means one config per org.
   *
   * `protocol` and the fields belonging to the OTHER protocol are PRESERVED when
   * the body omits them: the OIDC editor and the SAML editor are separate
   * surfaces on one settings page, so neither may wipe the other's connection
   * just by saving. `clientSecret` keeps its existing write-only semantics
   * (omitted = keep, which `controllers/org-idp-ops.ts` implements by
   * re-injecting the stored plaintext before validation).
   */
  async upsert(actor: string, input: OrgIdpConfigCreate): Promise<OrgIdpConfigDto> {
    const existing = await OrgIdpConfig.findOne({ orgId: input.orgId });
    if (existing) {
      if (input.protocol !== undefined) existing.protocol = input.protocol;
      if (input.provider !== undefined) existing.provider = input.provider;
      if (input.clientId !== undefined) existing.clientId = input.clientId;
      if (input.clientSecret) {
        existing.clientSecretEncrypted = await wrapEncrypted(input.clientSecret, input.orgId);
      }
      if (input.samlEntityId !== undefined) existing.samlEntityId = input.samlEntityId.trim();
      if (input.samlSsoUrl !== undefined) existing.samlSsoUrl = input.samlSsoUrl.trim();
      if (input.samlCertificates !== undefined) existing.samlCertificates = normalizeCertificates(input.samlCertificates);
      if (input.samlAttributes !== undefined) existing.samlAttributes = normalizeSamlAttributes(input.samlAttributes);
      if (input.discoveryUrl !== undefined) existing.discoveryUrl = input.discoveryUrl;
      if (input.region !== undefined) existing.region = input.region;
      if (input.userPoolId !== undefined) existing.userPoolId = input.userPoolId;
      if (input.groupsClaim !== undefined || input.provider !== undefined) {
        existing.groupsClaim = normalizeGroupsClaim(
          existing.protocol === 'saml' ? undefined : existing.provider,
          input.groupsClaim !== undefined ? input.groupsClaim : existing.groupsClaim,
        );
      }
      if (input.allowedEmailDomains !== undefined) existing.allowedEmailDomains = normalizeDomains(input.allowedEmailDomains);
      existing.enabled = input.enabled ?? true;
      existing.updatedBy = actor;
      assertProtocolComplete(existing);
      await existing.save();
      logger.info('OrgIdpConfig updated', { orgId: input.orgId, protocol: existing.protocol, provider: existing.provider });
      return toDto(existing);
    }
    const protocol: IdpProtocol = input.protocol ?? 'oidc';
    const draft = {
      orgId: input.orgId,
      protocol,
      provider: input.provider,
      clientId: input.clientId,
      clientSecretEncrypted: input.clientSecret ? await wrapEncrypted(input.clientSecret, input.orgId) : undefined,
      samlEntityId: input.samlEntityId?.trim(),
      samlSsoUrl: input.samlSsoUrl?.trim(),
      samlCertificates: normalizeCertificates(input.samlCertificates),
      samlAttributes: normalizeSamlAttributes(input.samlAttributes),
      discoveryUrl: input.discoveryUrl,
      region: input.region,
      userPoolId: input.userPoolId,
      groupsClaim: normalizeGroupsClaim(protocol === 'saml' ? undefined : input.provider, input.groupsClaim),
      allowedEmailDomains: normalizeDomains(input.allowedEmailDomains),
      enabled: input.enabled ?? true,
      createdBy: actor,
      updatedBy: actor,
    };
    assertProtocolComplete(draft as unknown as OrgIdpConfigDocument);
    const created = await OrgIdpConfig.create(draft);
    logger.info('OrgIdpConfig created', { orgId: input.orgId, protocol, provider: input.provider });
    return toDto(created);
  }

  /** Patch  only fields provided are updated. clientSecret omitted leaves
   * the existing encrypted blob untouched. */
  async patch(orgId: string, actor: string, input: OrgIdpConfigUpdate): Promise<OrgIdpConfigDto | null> {
    const existing = await OrgIdpConfig.findOne({ orgId });
    if (!existing) return null;

    if (input.protocol !== undefined) existing.protocol = input.protocol;
    if (input.provider !== undefined) existing.provider = input.provider;
    if (input.clientId !== undefined) existing.clientId = input.clientId;
    if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
      existing.clientSecretEncrypted = await wrapEncrypted(input.clientSecret, orgId);
    }
    if (input.samlEntityId !== undefined) existing.samlEntityId = input.samlEntityId.trim();
    if (input.samlSsoUrl !== undefined) existing.samlSsoUrl = input.samlSsoUrl.trim();
    if (input.samlCertificates !== undefined) existing.samlCertificates = normalizeCertificates(input.samlCertificates);
    if (input.samlAttributes !== undefined) existing.samlAttributes = normalizeSamlAttributes(input.samlAttributes);
    if (input.discoveryUrl !== undefined) existing.discoveryUrl = input.discoveryUrl;
    if (input.region !== undefined) existing.region = input.region;
    if (input.userPoolId !== undefined) existing.userPoolId = input.userPoolId;
    // Validated against the RESULTING provider (a patch may change both at once),
    // and re-validated when only the provider moves — switching an org with a
    // groups claim onto Google must fail loudly, not silently disable mapping.
    // A SAML config has no OIDC provider, and its groups come from an ATTRIBUTE,
    // so the Google carve-out simply doesn't apply there.
    if (input.groupsClaim !== undefined || input.provider !== undefined) {
      existing.groupsClaim = normalizeGroupsClaim(
        existing.protocol === 'saml' ? undefined : existing.provider,
        input.groupsClaim !== undefined ? input.groupsClaim : existing.groupsClaim,
      );
    }
    if (input.allowedEmailDomains !== undefined) existing.allowedEmailDomains = normalizeDomains(input.allowedEmailDomains);
    if (input.enabled !== undefined) existing.enabled = input.enabled;
    existing.updatedBy = actor;
    assertProtocolComplete(existing);
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
  async getLoginConfig(orgId: string): Promise<(OidcLoginConfig & { enabled: boolean; protocol: IdpProtocol }) | null> {
    const doc = await OrgIdpConfig.findOne({ orgId });
    if (!doc) return null;
    // A SAML config carries no client secret — decrypting is skipped rather than
    // throwing on an absent blob. `protocol` tells the enforcement layer which
    // of the two shapes it is actually holding.
    const clientSecret = doc.clientSecretEncrypted
      ? await unwrapEncrypted(doc.clientSecretEncrypted, doc.orgId, 'org-idp.clientSecret')
      : '';
    return {
      orgId: doc.orgId,
      protocol: doc.protocol ?? 'oidc',
      provider: doc.provider ?? 'generic-oidc',
      clientId: doc.clientId ?? '',
      clientSecret,
      discoveryUrl: doc.discoveryUrl ?? '',
      region: doc.region,
      userPoolId: doc.userPoolId,
      groupsClaim: doc.groupsClaim,
      allowedEmailDomains: doc.allowedEmailDomains ?? [],
      enabled: doc.enabled,
    };
  }

  /**
   * INTERNAL LOGIN PATH ONLY — the SAML half of {@link getLoginConfig} (#4).
   *
   * Nothing here is secret (an IdP's entity id, endpoint and signing
   * certificates are all public by design), which is why the SAML settings API
   * returns them in full and this reader needs no decryption step at all.
   * Returns `enabled` + `protocol` so the enforcement layer decides whether to
   * honour it; null when the org has no config.
   */
  async getSamlLoginConfig(orgId: string): Promise<(SamlLoginConfig & { enabled: boolean; protocol: IdpProtocol }) | null> {
    const doc = await OrgIdpConfig.findOne({ orgId });
    if (!doc) return null;
    return {
      orgId: doc.orgId,
      protocol: doc.protocol ?? 'oidc',
      entityId: doc.samlEntityId ?? '',
      ssoUrl: doc.samlSsoUrl ?? '',
      certificates: doc.samlCertificates ?? [],
      attributes: {
        email: doc.samlAttributes?.email,
        name: doc.samlAttributes?.name,
        groups: doc.samlAttributes?.groups,
      },
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
