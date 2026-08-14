// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org IdP configuration.
 *
 * Stores the per-org SSO/IdP settings for a customer's identity provider. The
 * OIDC enforcement runtime that reads this collection IS shipped:
 * `services/oidc-service.ts` (discovery + JWKS-validated id_token),
 * `helpers/sso-enforcement.ts` (entitlement + `allowedEmailDomains` domain
 * gating), `controllers/sso.ts` + `routes/sso.ts` (the `/auth/sso/*` login
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

import { Schema, model, Document } from 'mongoose';

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

export interface OrgIdpConfigDocument extends Document {
  /** Org this config applies to. One config per org max  enforced by unique index. */
  orgId: string;

  provider: IdpProvider;

  /** OIDC client id  public, never encrypted. */
  clientId: string;
  /** JSON-stringified EncryptedBlob. NEVER returned plaintext via CRUD. */
  clientSecretEncrypted: string;

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
   * If set, only IdP users whose email matches one of these domains are
   * allowed to sign in to this org. Defense against an over-broad IdP that
   * authenticates anyone in a corporate domain  pinning to `acme.com`
   * keeps `evil-contractor.com` users out even if they have an account on
   * the same IdP.
   */
  allowedEmailDomains: string[];

  /** Soft on/off  disabled configs are kept around so re-enabling doesn't
   * require re-entering credentials. */
  enabled: boolean;

  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const orgIdpConfigSchema = new Schema<OrgIdpConfigDocument>( {
  orgId: { type: String, required: true, index: true },
  provider: {
    type: String,
    enum: IDP_PROVIDERS as unknown as string[],
    required: true,
  },
  clientId: { type: String, required: true },
  clientSecretEncrypted: { type: String, required: true },
  discoveryUrl: { type: String },
  region: { type: String },
  userPoolId: { type: String },
  allowedEmailDomains: { type: [String], default: [] },
  enabled: { type: Boolean, default: true },
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
orgIdpConfigSchema.index({ orgId: 1 }, { unique: true });

export default model<OrgIdpConfigDocument>('OrgIdpConfig', orgIdpConfigSchema);
