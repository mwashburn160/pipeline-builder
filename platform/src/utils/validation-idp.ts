// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request schemas for the per-org identity-provider surface: the OIDC/SAML
 * config itself, its metadata import, the SAML ACS/landing hand-off, and the
 * IdP-group → Role mappings.
 *
 * Split out of `utils/validation.ts` because this is the one cluster with real
 * cross-field rules (protocol-conditional requirements, reserved-issuer
 * refusals) rather than plain shape checks, and it is read by exactly the
 * IdP/SAML controllers.
 */

import { z } from 'zod';
import { isCustomGoogleDiscoveryUrl, isReservedDiscoveryUrl, isReservedIssuer } from '../helpers/reserved-issuers.js';

// Org IdP (per-org SSO) Schemas

/** Supported IdP (SSO) providers. Mirrors `IdpProvider` in
 *  models/org-idp-config.ts — the OIDC-capable set. `facebook` is deliberately
 *  ABSENT: it is an OAuth2 social login (no OIDC id_token), not an SSO IdP. */
const idpProviderSchema = z.enum(['generic-oidc', 'cognito', 'google', 'github']);

/** AWS Cognito user-pool id, e.g. `us-east-1_Ab12Cd34`. NOT an AWS account id. */
const userPoolIdSchema = z.string().regex(/^[\w-]+_[A-Za-z0-9]+$/, 'Invalid Cognito userPoolId');
/** AWS region, e.g. `us-east-1`. */
const awsRegionSchema = z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, 'Invalid AWS region');

/** Create/upsert an org IdP config. Core credentials are required non-empty
 *  strings; `generic-oidc` additionally requires a discoveryUrl, and `cognito`
 *  requires region + userPoolId (from which the discovery URL is derived). */
/** Name of the id_token claim carrying group memberships. Claim names are
 *  JSON keys and are frequently namespaced (`cognito:groups`,
 *  `https://acme.example/groups`), so the shape is deliberately permissive —
 *  what it may NOT be is a provider that issues no groups at all (below). */
const groupsClaimSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9_.:/-]+$/, 'groupsClaim must be a claim name (letters, digits, and _ . : / -)');

/** Google issues no group claims, so a mapping configured against it could only
 *  ever match nothing. Refused with an explanation instead of silently accepted.
 *  (The service repeats this check — see `normalizeGroupsClaim`.) */
const GOOGLE_GROUPS_MESSAGE =
  'Group-to-Role mapping is not available for Google: Google\'s OIDC tokens carry no group claim. Use a generic OIDC or Cognito identity provider for just-in-time Role mapping.';

/** Reserved issuers (Google) carry domain-trust, so no admin-entered value may
 *  claim one: Google has its own provider with a hard-coded discovery document,
 *  and a generic OIDC or SAML IdP may not present Google's issuer. The service
 *  re-checks the RESULTING document (`assertNoReservedIssuer`). */
const RESERVED_ISSUER_MESSAGE =
  'This value is reserved for Google. Use the Google provider — it always uses Google\'s own discovery document — rather than a custom discovery URL or entity ID.';
function noReservedIssuer(data: { protocol?: string; provider?: string; discoveryUrl?: string; samlEntityId?: string }): boolean {
  if (isReservedIssuer(data.samlEntityId)) return false;
  if (data.provider === 'google') return !isCustomGoogleDiscoveryUrl(data.discoveryUrl);
  return !isReservedDiscoveryUrl(data.discoveryUrl);
}

/** Which protocol the org federates over. Mirrors `IdpProtocol` in
 *  models/org-idp-config.ts. */
const idpProtocolSchema = z.enum(['oidc', 'saml']);

/** A SAML IdP's `entityID`. It is a URI by convention but the spec only says
 *  "a string up to 1024 characters", and real IdPs do emit non-URL values
 *  (Entra's `https://sts.windows.net/<tenant>/` alongside ADFS's bare urns), so
 *  only length is constrained. */
const samlEntityIdSchema = z.string().trim().min(1).max(1024);

/** The IdP's SSO endpoint. Must be https — an AuthnRequest carries the user's
 *  session to it and the assertion comes back through the browser. */
const samlSsoUrlSchema = z.string().trim().url().refine(
  (u) => u.startsWith('https://'),
  { message: 'The identity provider SSO URL must use https' },
);

/** One IdP signing certificate: PEM or bare base64, capped so a paste accident
 *  can't push an unbounded blob into the config. Shape is checked by
 *  node-saml at use time — it is the authority on what it can parse. */
const samlCertificateSchema = z.string().trim().min(64).max(20_000);

/** Up to three trusted certificates. Three is one more than a rotation needs
 *  (outgoing + incoming), which leaves room for an IdP that publishes a spare
 *  without letting the trust list grow into a place old keys go to hide. */
const samlCertificatesSchema = z.array(samlCertificateSchema).max(3);

/** Assertion attribute names. Long URI-shaped names are the norm (Entra,
 *  Shibboleth), so this is length-bounded rather than pattern-bound. */
const samlAttributeNameSchema = z.string().trim().max(256);

const samlAttributesSchema = z.object({
  email: samlAttributeNameSchema.optional(),
  name: samlAttributeNameSchema.optional(),
  groups: samlAttributeNameSchema.optional(),
}).strict();

/** The IdP's Single Logout endpoint — https, or `''` to clear it. */
const samlSloUrlSchema = z.union([
  z.string().trim().url().refine((u) => u.startsWith('https://'), { message: 'The identity provider single-logout URL must use https' }),
  z.literal(''),
]);

/**
 * Per-protocol required fields.
 *
 * `protocol` is OPTIONAL on the wire because the OIDC editor and the SAML editor
 * are separate surfaces on one settings page and neither sends the other's
 * fields: omitted means "leave the stored protocol alone", which the service
 * honours. For VALIDATION an omitted protocol is treated as `oidc`, since the
 * only body that omits it is the OIDC editor's — and the service's
 * `assertProtocolComplete` is the backstop that checks the RESULTING document
 * either way.
 */
function requiredFieldsPresent(data: {
  protocol?: 'oidc' | 'saml';
  provider?: string;
  clientId?: string;
  clientSecret?: string;
  samlEntityId?: string;
  samlSsoUrl?: string;
  samlCertificates?: string[];
}): boolean {
  if (data.protocol === 'saml') {
    return !!data.samlEntityId && !!data.samlSsoUrl && (data.samlCertificates?.length ?? 0) > 0;
  }
  return !!data.provider && !!data.clientId && !!data.clientSecret;
}

export const orgIdpCreateSchema = z.object({
  orgId: z.string().min(1),
  protocol: idpProtocolSchema.optional(),
  provider: idpProviderSchema.optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  samlEntityId: samlEntityIdSchema.optional(),
  samlSsoUrl: samlSsoUrlSchema.optional(),
  samlCertificates: samlCertificatesSchema.optional(),
  samlAttributes: samlAttributesSchema.optional(),
  samlSloUrl: samlSloUrlSchema.optional(),
  samlSignAuthnRequests: z.boolean().optional(),
  samlEncryptAssertions: z.boolean().optional(),
  discoveryUrl: z.string().optional(),
  region: awsRegionSchema.optional(),
  userPoolId: userPoolIdSchema.optional(),
  /** Empty string means "no groups claim" — the editor sends it to clear the
   *  field (and always sends it for a provider that has no groups). */
  groupsClaim: z.union([groupsClaimSchema, z.literal('')]).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
}).refine(
  requiredFieldsPresent,
  { message: 'An OIDC config requires provider, clientId and clientSecret; a SAML config requires samlEntityId, samlSsoUrl and at least one certificate', path: ['protocol'] },
).refine(
  data => data.protocol === 'saml' || data.provider !== 'generic-oidc' || !!data.discoveryUrl,
  { message: 'discoveryUrl is required for generic-oidc provider', path: ['discoveryUrl'] },
).refine(
  data => data.protocol === 'saml' || data.provider !== 'cognito' || (!!data.region && !!data.userPoolId),
  { message: 'region and userPoolId are required for cognito provider', path: ['userPoolId'] },
).refine(
  data => !data.groupsClaim || data.protocol === 'saml' || (data.provider !== 'google' && data.provider !== 'github'),
  { message: GOOGLE_GROUPS_MESSAGE, path: ['groupsClaim'] },
).refine(
  noReservedIssuer,
  { message: RESERVED_ISSUER_MESSAGE, path: ['discoveryUrl'] },
);

/** Partial update of an org IdP config. Every field optional; unset fields
 *  are left untouched by the service. */
export const orgIdpPatchSchema = z.object({
  protocol: idpProtocolSchema.optional(),
  provider: idpProviderSchema.optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  samlEntityId: samlEntityIdSchema.optional(),
  samlSsoUrl: samlSsoUrlSchema.optional(),
  samlCertificates: samlCertificatesSchema.optional(),
  samlAttributes: samlAttributesSchema.optional(),
  samlSloUrl: samlSloUrlSchema.optional(),
  samlSignAuthnRequests: z.boolean().optional(),
  samlEncryptAssertions: z.boolean().optional(),
  discoveryUrl: z.string().optional(),
  region: awsRegionSchema.optional(),
  userPoolId: userPoolIdSchema.optional(),
  /** Empty string CLEARS the claim back to the `groups` default. */
  groupsClaim: z.union([groupsClaimSchema, z.literal('')]).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  /** Org policy "SSO required". Switching it ON is gated server-side on an
   *  enabled IdP, a verified domain and a successful test connection. */
  ssoRequired: z.boolean().optional(),
}).refine(
  data => !data.groupsClaim || data.protocol === 'saml' || (data.provider !== 'google' && data.provider !== 'github'),
  { message: GOOGLE_GROUPS_MESSAGE, path: ['groupsClaim'] },
).refine(
  noReservedIssuer,
  { message: RESERVED_ISSUER_MESSAGE, path: ['discoveryUrl'] },
);

// SAML login flow

/**
 * What an IdP POSTs to the ACS. `RelayState` is optional ON THE WIRE — an
 * IdP-initiated response simply has none — and its ABSENCE is exactly what the
 * controller refuses, so validation must let it through to be refused there with
 * its own reason rather than collapsing it into a generic 400.
 *
 * The size cap is generous: a signed assertion carrying group memberships for a
 * large directory runs to tens of kilobytes, and the global 1 MB body limit is
 * the real backstop.
 */
export const samlAcsSchema = z.object({
  SAMLResponse: z.string().min(1).max(500_000),
  RelayState: z.string().max(512).optional(),
});

/** IdP metadata import: a pasted/uploaded XML document OR a URL to fetch —
 *  exactly one. The XML cap matches the fetch cap in controllers/org-idp-self.ts. */
export const idpMetadataImportSchema = z.union([
  z.object({ xml: z.string().min(1).max(512 * 1024) }).strict(),
  z.object({ url: z.string().trim().url().refine((u) => u.startsWith('https://'), { message: 'The metadata URL must use https' }) }).strict(),
]);

/** The landing page redeeming the ACS's one-time handoff. */
export const samlCompleteSchema = z.object({
  handoff: z.string().min(1).max(256),
});

// IdP group → Role mapping

/** A group value as the IdP asserts it. Free text — directories use spaces,
 *  slashes and distinguished names — so only length is constrained. */
const idpGroupSchema = z.string().trim().min(1).max(256);

/** Create a group → Role mapping. At least one Role: a rule granting nothing
 *  would be indistinguishable from no rule at all. */
export const idpGroupMappingCreateSchema = z.object({
  group: idpGroupSchema,
  roleIds: z.array(z.string()).min(1).max(20),
});

/** Update a mapping. Either half may be edited on its own. */
export const idpGroupMappingUpdateSchema = z.object({
  group: idpGroupSchema.optional(),
  roleIds: z.array(z.string()).min(1).max(20).optional(),
}).refine(
  data => data.group !== undefined || data.roleIds !== undefined,
  { message: 'Provide a group and/or roleIds to update' },
);
