// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 *  Per-org IdP configuration (scaffolding).
 *
 * Stores the per-org SSO/IdP settings a sysadmin registers on a customer's
 * behalf. THIS MODEL IS FOUNDATION ONLY  the auth middleware that dispatches
 * by org is intentionally not shipped here because the user/role provisioning
 * policy is customer-driven (JIT user creation? Role mapping from which
 * claim? Account-link existing users by email?).
 *
 * Activation runbook: when a customer asks for SSO, the auth flow that
 * reads from this collection lands in a follow-up. The data layer + CRUD
 * surface here lets a sysadmin pre-register IdP credentials so the cutover
 * is a code-only deploy, not a code+data migration.
 *
 * Secrets * - `clientSecret` is encrypted at write via the encryption primitive
 * (HKDF-derived per-org key + AES-256-GCM). Stored as the JSON-stringified
 * EncryptedBlob  same shape `aiProviderKeys` uses post- for
 * consistency.
 * - Reads via `getDecryptedClientSecret` return plaintext for use during
 * the OIDC token exchange. CRUD reads never return the plaintext.
 */

import { Schema, model, Document } from 'mongoose';
import { OAuthProviderName, OAUTH_PROVIDER_NAMES } from '../types/oauth-provider';

/** Supported IdP providers. `generic-oidc` is the broad case — any OIDC-compliant
 * IdP with discovery URL works (Okta, Auth0, Keycloak, AWS Cognito, Azure AD).
 * The named providers (`google` / `github`) come from the shared
 * `OAuthProviderName` union because they have wired-up OAuth flows in
 * `controllers/oauth.ts` that the follow-on dispatcher will re-use rather
 * than duplicate. */
export type IdpProvider = 'generic-oidc' | OAuthProviderName;

/** Runtime list of `IdpProvider` values for Mongoose enum / Zod schemas. */
const IDP_PROVIDERS: readonly IdpProvider[] = ['generic-oidc', ...OAUTH_PROVIDER_NAMES];

export interface OrgIdpConfigDocument extends Document {
  /** Org this config applies to. One config per org max  enforced by unique index. */
  orgId: string;

  provider: IdpProvider;

  /** OIDC client id  public, never encrypted. */
  clientId: string;
  /** JSON-stringified EncryptedBlob. NEVER returned plaintext via CRUD. */
  clientSecretEncrypted: string;

  /** OIDC discovery URL (https://issuer/.well-known/openid-configuration).
   * Required for `generic-oidc`; ignored for the named providers. */
  discoveryUrl?: string;

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
