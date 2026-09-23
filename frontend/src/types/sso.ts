// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Per-org identity-provider configuration: what an administrator registers at
 *  their IdP, what a metadata document yields, and what a test connection reports. */

import type { IdpProtocol, IdpProvider, RoleGrant, SamlAttributeMapping } from '@pipeline-builder/api-core';

/**
 * Everything an administrator registers AT their identity provider, computed by
 * the server from its own public URL and SP keys (`GET /organization/:id/idp/sp-info`)
 * — the UI never derives these from the browser's origin. Available before any
 * connection exists.
 */
export interface SsoSpInfo {
  /** SAML: this SP's entity ID (also the metadata URL). */
  entityId: string;
  /** SAML: Assertion Consumer Service (HTTP-POST). */
  acsUrl: string;
  /** SAML: SP metadata document. */
  metadataUrl: string;
  /** SAML: Single Logout endpoint (HTTP-Redirect and HTTP-POST). */
  sloUrl: string;
  /** OIDC: the redirect (callback) URI to register with the IdP. */
  oidcRedirectUri: string;
  /** SAML: the SP signing certificate (PEM) — for signed requests and SLO. */
  signingCertificate: string;
  /** SAML: the SP encryption certificate (PEM) — for encrypted assertions. */
  encryptionCertificate: string;
}

/** What an IdP metadata document yields for the SAML form (never saved by itself). */
export interface ParsedIdpMetadata {
  entityId: string;
  ssoUrl: string;
  sloUrl?: string;
  certificates: string[];
  /** The IdP asks for signed AuthnRequests. */
  wantsSignedRequests: boolean;
}

/** The outcome of a test connection (a dry run — no session, user or membership). */
export interface SsoTestReport {
  ok: boolean;
  protocol: IdpProtocol;
  testedAt: string;
  /** Stable failure code, e.g. `invalid_assertion`, `domain_not_verified`. */
  reason?: string;
  message?: string;
  identity?: { email: string; name?: string; subject: string; issuer: string; groups: string[] };
  /** The group → role mappings that WOULD apply at sign-in. */
  mappings?: { matchedGroups: string[]; roles: Array<{ id: string; name: string }> };
  /** Recorded as the connection's last test (false if the settings changed mid-test). */
  recorded?: boolean;
}

/** Per-org IdP config. The client secret never crosses the wire; the UI shows `hasClientSecret`. */
export interface OrgIdpConfigDto {
  orgId: string;
  protocol: IdpProtocol;
  /** OIDC only — absent on a SAML config. */
  provider?: IdpProvider;
  clientId?: string;
  hasClientSecret: boolean;
  /** SAML: the IdP's entity ID (its `Issuer`). */
  samlEntityId?: string;
  /** SAML: the IdP's SSO endpoint (HTTP-Redirect binding). */
  samlSsoUrl?: string;
  /** SAML: trusted IdP signing certificates — more than one while a rotation's
   *  overlap window is open. Public certificates, so they are returned in full. */
  samlCertificates: string[];
  samlAttributes?: SamlAttributeMapping;
  /** SAML: the IdP's Single Logout endpoint. */
  samlSloUrl?: string;
  /** SAML: AuthnRequests are signed with the deployment's SP key. */
  samlSignAuthnRequests: boolean;
  /** SAML: the IdP encrypts assertions (plaintext ones are then refused). */
  samlEncryptAssertions: boolean;
  discoveryUrl?: string;
  /** Cognito only: the discovery URL is derived server-side from these. */
  region?: string;
  userPoolId?: string;
  /** id_token claim carrying group memberships, for just-in-time Role mapping.
   *  Absent = the `groups` default. Never set for Google (no group claims). */
  groupsClaim?: string;
  /** Verified domains the connection is restricted to (empty = all verified domains). */
  allowedEmailDomains: string[];
  enabled: boolean;
  /** Org policy: people in the org's verified domains must sign in via the IdP
   *  (owners exempt). */
  ssoRequired: boolean;
  /** The last test connection against the CURRENT settings (cleared on change). */
  lastTest?: { at: string; ok: boolean; protocol: IdpProtocol; reason?: string };
  updatedAt: string;
}

/**
 * One IdP group → Role mapping rule. At SSO sign-in the groups on the user's
 * id_token are matched against these (case-insensitively) and the union of their
 * Roles is granted in that org. `roles` is the hydrated form of `roleIds` so the
 * editor can name what a group grants without a second request.
 */
export interface IdpGroupMappingDto {
  id: string;
  group: string;
  roleIds: string[];
  roles: Array<{ id: string; name: string; grantsRole: 'superadmin' | 'admin' | 'member' }>;
  updatedAt: string;
}

/** Create-IdP payload. `clientSecret` is required on create. */
export interface OrgIdpConfigCreate {
  orgId?: string;
  /** Omitted leaves the stored protocol alone — the OIDC and SAML editors are
   *  separate surfaces on one page, and neither may wipe the other's
   *  connection just by saving. */
  protocol?: IdpProtocol;
  provider?: IdpProvider;
  clientId?: string;
  clientSecret?: string;
  /** SAML: required together when `protocol` is `saml`. */
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlCertificates?: string[];
  samlAttributes?: SamlAttributeMapping;
  /** `''` clears it. */
  samlSloUrl?: string;
  samlSignAuthnRequests?: boolean;
  samlEncryptAssertions?: boolean;
  discoveryUrl?: string;
  /** Cognito only: server derives the discovery URL from region + userPoolId. */
  region?: string;
  userPoolId?: string;
  /** Rejected by the server for Google/GitHub — they issue no group claims. */
  groupsClaim?: string;
  /** Must be DNS-verified domains of the org (or its account root). */
  allowedEmailDomains?: string[];
  enabled?: boolean;
  /** PATCH only. Switching ON needs an enabled IdP, a verified domain and a
   *  successful test connection of the current settings. */
  ssoRequired?: boolean;
}

