// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org IdP configuration.
 *
 * Stores the per-org SSO/IdP settings for a customer's identity provider. Two
 * protocols ride this one document, selected by `protocol`: OIDC (the original)
 * and SAML 2.0 (`services/saml-service.ts` + `controllers/saml.ts`). Both end at
 * the same verified identity and the same checks.
 *
 * The OIDC enforcement runtime that reads this collection IS shipped:
 * `services/oidc-service.ts` (discovery + JWKS-validated id_token),
 * `helpers/sso-enforcement.ts` (entitlement, verified-domain coverage and the
 * "SSO required" policy), `controllers/sso.ts` + `routes/sso.ts` (the `/auth/sso/*` login
 * flow). Config is managed from two surfaces: the superadmin fleet routes
 * (`/admin/org-idp`) and org-admin self-service (`controllers/org-idp-self.ts`,
 * gated on `org:settings`). Users are account-linked by verified email
 * (JIT-created if absent), mirroring the OAuth social-login path.
 *
 * Secrets * - `clientSecret` is encrypted at write via the encryption primitive
 * (HKDF-derived per-org key + AES-256-GCM). Stored as the JSON-stringified
 * EncryptedBlob  same shape `aiProviderKeys` uses post- for
 * consistency.
 * - Reads via `getDecryptedClientSecret` return plaintext for use during
 * the OIDC token exchange. CRUD reads never return the plaintext.
 */

import { Schema, model, type HydratedDocument, Types } from 'mongoose';

/** Supported IdP (SSO) providers — the OIDC-capable set. This is DELIBERATELY
 * NOT derived from `OAuthProviderName`: that union carries OAuth2 social logins
 * (e.g. `facebook`) that are NOT standards-OIDC and therefore can't drive the
 * per-org SSO id_token flow.
 *
 * - `generic-oidc` — the broad case: any OIDC issuer with a discovery URL
 *   (Okta, Auth0, Keycloak, Azure AD).
 * - `cognito`      — AWS Cognito, a NAMED OIDC provider: the admin supplies
 *   `region` + `userPoolId` and the discovery URL is DERIVED
 *   (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration`),
 *   so no hand-entered URL. A user-pool id is NOT an AWS account id — safe to store.
 * - `google`       — OIDC-compliant; discovery is well-known.
 * - `github`       — present for parity with the OAuth handlers, but GitHub is
 *   NOT an OpenID provider (no id_token); the OIDC engine rejects it. */
export type IdpProvider = 'generic-oidc' | 'cognito' | 'google' | 'github';

/** Runtime list of `IdpProvider` values for Mongoose enum / Zod schemas. */
const IDP_PROVIDERS: readonly IdpProvider[] = ['generic-oidc', 'cognito', 'google', 'github'];

/**
 * Which federation protocol this org's IdP speaks.
 *
 * One config per org still holds: an org federates over OIDC **or** SAML, never
 * both at once, and this selector is what the login path dispatches on. The
 * fields for the other protocol are simply left alone when the selector moves,
 * so switching back does not mean re-entering a connection from scratch.
 */
export type IdpProtocol = 'oidc' | 'saml';

/** Runtime list of `IdpProtocol` values for Mongoose enum / Zod schemas. */
export const IDP_PROTOCOLS: readonly IdpProtocol[] = ['oidc', 'saml'];

/**
 * Which assertion attribute carries which identity field.
 *
 * SAML IdPs disagree far more than OIDC ones do: Entra sends the long
 * `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` URIs,
 * Okta and Keycloak send short names (`email`, `groups`), Shibboleth sends OID
 * URNs. Rather than hard-code a guess list, the org names the attributes; the
 * lookup falls back to the common spellings when a name is left empty.
 */
export interface SamlAttributeMapping {
  /** Attribute holding the user's email address. */
  email?: string;
  /** Attribute holding the display name. */
  name?: string;
  /** Attribute holding group memberships (drives JIT Role mapping). */
  groups?: string;
}

/** The outcome of the last test connection, as persisted on the config. */
export interface IdpTestRecord {
  at: Date;
  ok: boolean;
  protocol: IdpProtocol;
  /** Stable failure code when `ok` is false. */
  reason?: string;
  /** Who ran it. */
  actorId: string;
}

export interface OrgIdpConfigData {
  /** Org this config applies to. One config per org max  enforced by unique index. */
  organizationId: Types.ObjectId;

  /** OIDC | SAML; the schema default is OIDC. */
  protocol: IdpProtocol;

  /** OIDC provider. Required for `protocol: 'oidc'`; unused for SAML, where the
   *  IdP is identified by its entity id rather than by a named provider. */
  provider?: IdpProvider;

  /** OIDC client id  public, never encrypted. Unused for SAML. */
  clientId?: string;
  /** JSON-stringified EncryptedBlob. NEVER returned plaintext via CRUD.
   *  Unused for SAML — SAML needs no client credential; the trust is the IdP's
   *  signing certificate (and, for signed requests, the deployment SP key). */
  clientSecretEncrypted?: string;

  /** SAML: the IdP's `entityID` (its `Issuer`). Every assertion must carry it,
   *  so a second IdP's assertion can never be accepted for this org. */
  samlEntityId?: string;

  /** SAML: the IdP's SSO endpoint (HTTP-Redirect binding) that the AuthnRequest
   *  is sent to. SP-initiated sign-in is the ONLY supported entry point. */
  samlSsoUrl?: string;

  /**
   * SAML: the IdP's signing certificate(s), PEM or bare base64.
   *
   * A LIST, not a single value, because that is what makes certificate rotation
   * a non-event: during the overlap window both the outgoing and the incoming
   * certificate are trusted, so assertions signed by either verify, and the old
   * one is removed once the IdP has cut over. See
   * docs/runbooks/secret-rotation.md.
   */
  samlCertificates: string[];

  /** SAML: per-org attribute names for email / name / groups. */
  samlAttributes?: SamlAttributeMapping;

  /** SAML: the IdP's Single Logout endpoint (HTTP-Redirect binding). When set,
   *  signing out of a SAML session also sends a signed LogoutRequest there. */
  samlSloUrl?: string;

  /** SAML: sign AuthnRequests with this deployment's SP signing key
   *  (services/saml-sp-keys.ts). Off by default — most IdPs accept unsigned
   *  requests, and turning it on requires the IdP to hold the SP certificate. */
  samlSignAuthnRequests: boolean;

  /** SAML: the IdP ENCRYPTS assertions to the SP encryption key. When on, a
   *  response carrying a plaintext assertion is refused; when off, an encrypted
   *  one is (there is no key to decrypt it with). */
  samlEncryptAssertions: boolean;

  /** OIDC discovery URL (https://issuer/.well-known/openid-configuration).
   * Required for `generic-oidc`. For `cognito` it is DERIVED from region +
   * userPoolId; for `google` it is well-known. */
  discoveryUrl?: string;

  /** AWS Cognito region (e.g. `us-east-1`). Required for `provider: 'cognito'`;
   *  used to derive the discovery URL. Not persisted for other providers. */
  region?: string;

  /** AWS Cognito user-pool id (e.g. `us-east-1_abc123`). Required for
   *  `provider: 'cognito'`. NOT an AWS account id — safe to store. */
  userPoolId?: string;

  /**
   * Name of the id_token claim carrying the user's GROUP memberships, for
   * just-in-time membership + Role mapping. IdPs disagree on it — Okta and
   * Keycloak emit `groups`, Cognito emits `cognito:groups`, Entra emits `roles`
   * — so it is configurable per org. Unset means the default (`groups`).
   *
   * NOT supported for `provider: 'google'`: Google's OIDC tokens carry no group
   * claim at all, so a mapping there could only ever match nothing. The write
   * path refuses to set it (and to create mappings) for a Google config rather
   * than let an admin build a rule set that silently never fires.
   */
  groupsClaim?: string;

  /**
   * Narrows which of the org's DNS-VERIFIED domains this connection serves.
   * Empty = every verified domain of the org (or its account root). Each entry
   * must itself be verified — the write path refuses anything else
   * (`IDP_DOMAIN_NOT_VERIFIED`), so this is a picker over verified domains, not
   * free text. Only IdP users whose email is in a served domain may sign in to
   * this org (defense against an over-broad IdP: pinning to `acme.com` keeps
   * `evil-contractor.com` users out even if they have an account on the same
   * IdP), and it is the set the "SSO required" policy governs.
   */
  allowedEmailDomains: string[];

  /** Soft on/off  disabled configs are kept around so re-enabling doesn't
   * require re-entering credentials. */
  enabled: boolean;

  /**
   * ORG POLICY "SSO required". When on (and the IdP is enabled + entitled),
   * people whose email domain the org has DNS-VERIFIED must sign in through this
   * IdP: password, passkey and social sign-in are refused for them with
   * `SSO_REQUIRED`. Organization OWNERS are exempt (the break-glass path — see
   * helpers/sso-enforcement.ts). Can only be switched ON once a test connection
   * has succeeded against the current connection settings (`lastTest`).
   */
  ssoRequired: boolean;

  /**
   * The most recent dry-run "test connection" (controllers/sso-test.ts). Cleared
   * whenever a connection-affecting field changes, so a success always speaks
   * for the settings that are actually saved.
   */
  lastTest?: IdpTestRecord;

  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type OrgIdpConfigDocument = HydratedDocument<OrgIdpConfigData>;

const orgIdpConfigSchema = new Schema<OrgIdpConfigData>( {
  organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
  protocol: {
    type: String,
    enum: [...IDP_PROTOCOLS],
    default: 'oidc',
  },
  // Provider/clientId/clientSecret are REQUIRED for OIDC and absent for SAML, so
  // the per-protocol requirement lives in the Zod write schemas + the service's
  // completeness check rather than in the Mongoose schema, which cannot express
  // "required when another field has a given value".
  provider: {
    type: String,
    enum: [...IDP_PROVIDERS],
  },
  clientId: { type: String },
  clientSecretEncrypted: { type: String },
  samlEntityId: { type: String },
  samlSsoUrl: { type: String },
  samlCertificates: { type: [String], default: [] },
  samlAttributes: {
    type: new Schema<SamlAttributeMapping>({
      email: { type: String },
      name: { type: String },
      groups: { type: String },
    }, { _id: false }),
  },
  samlSloUrl: { type: String },
  samlSignAuthnRequests: { type: Boolean, default: false },
  samlEncryptAssertions: { type: Boolean, default: false },
  discoveryUrl: { type: String },
  region: { type: String },
  userPoolId: { type: String },
  groupsClaim: { type: String },
  allowedEmailDomains: { type: [String], default: [] },
  enabled: { type: Boolean, default: true },
  ssoRequired: { type: Boolean, default: false },
  lastTest: {
    type: new Schema<IdpTestRecord>({
      at: { type: Date, required: true },
      ok: { type: Boolean, required: true },
      protocol: { type: String, enum: [...IDP_PROTOCOLS], required: true },
      reason: { type: String },
      actorId: { type: String, required: true },
    }, { _id: false }),
  },
  createdBy: { type: String, required: true },
  updatedBy: { type: String, required: true },
},
{
  timestamps: true,
  collection: 'org_idp_configs',
},
);

// One config per org. A re-register flow updates the existing doc rather
// than inserting; the route enforces this so we don't get the case of two
// active configs racing during a sign-in attempt.
orgIdpConfigSchema.index({ organizationId: 1 }, { unique: true });

export default model<OrgIdpConfigData>('OrgIdpConfig', orgIdpConfigSchema);
