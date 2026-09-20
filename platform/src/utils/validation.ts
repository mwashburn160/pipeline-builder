// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, STANDARD_TIERS, TOKEN_SCOPES, sendError, type QuotaTier } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { z } from 'zod';
import { EMAIL_PATTERN } from './email-address.js';
import { config } from '../config/index.js';
import { MAX_MFA_GRACE_DAYS } from '../helpers/mfa-policy.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_RULES } from '../models/user.js';

/**
 * Validate data against a Zod schema.
 * Returns parsed value or null (sends 400 response on failure).
 *
 * Note: the "side-effect-on-fail + return null" pattern (writing the 400
 * directly to `res` and signaling failure with `null`) is unusual — most
 * validation helpers throw and let an error middleware translate. We keep
 * it because every controller in this service uses the
 *   `const body = validateBody(...); if (!body) return;`
 * idiom; switching to throws would touch every consumer for no real win.
 * If/when controllers move to a centralized error wrapper, swap this for
 * `validateBodyOrThrow`.
 */
export function validateBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  res: Response,
): T | null {
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const firstIssue = error.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Validation failed';
      sendError(res, 400, message, 'VALIDATION_ERROR');
      return null;
    }
    sendError(res, 400, 'Validation failed', 'VALIDATION_ERROR');
    return null;
  }
}

/**
 * Relaxed email rule: requires local@domain but does NOT require a TLD, so both
 * "user@internal" and "user@internal.com" are accepted. The pattern itself lives
 * in `utils/email.ts` — a dependency-free module — so a caller that only needs
 * to check an address doesn't pull this file's model graph in behind it.
 */
export const emailSchema = z.string().regex(EMAIL_PATTERN, 'Invalid email address');

/**
 * Password schema: enforces minimum length and every rule in `PASSWORD_RULES`
 * (uppercase, lowercase, digit). Rules are sourced from `models/user.ts` so
 * the Mongoose pre-save hook and the Zod-based request validators stay in
 * lockstep; adding a rule there propagates here automatically.
 */
const passwordSchema = PASSWORD_RULES.reduce(
  (schema, rule) => schema.regex(rule.test, rule.message),
  z.string().min(config.auth.passwordMinLength).max(PASSWORD_MAX_LENGTH),
);

// Auth Schemas

/** Registration request body schema. */
export const registerSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Username must contain only letters, numbers, hyphens, and underscores'),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().min(2).max(100).optional(),
  planId: z.string().optional(),
  /** Registering to accept an invitation: the inviting org's password policy
   *  applies to the new password (see helpers/password-policy.ts). */
  invitationToken: z.string().min(1).max(256).optional(),
});

/** First-run onboarding completion (social-signup users): name the auto-created
 *  org and optionally pick a plan. Both optional — an empty body just clears the
 *  onboarding flag. */
export const completeOnboardingSchema = z.object({
  organizationName: z.string().min(2).max(100).optional(),
  planId: z.string().optional(),
});

/** Register a domain for an org (domain-based join). A DNS hostname. */
export const addDomainSchema = z.object({
  domain: z.string().trim().toLowerCase().min(3).max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'Must be a valid domain (e.g. acme.com)'),
});

/** Set a domain's discovery mode. */
export const setDomainModeSchema = z.object({
  autoJoin: z.enum(['off', 'request', 'auto']),
});

/** Onboarding: join a domain-discovered org. */
export const joinOrgSchema = z.object({
  orgId: z.string().min(1),
});

/** Login request body schema (identifier can be username or email). */
export const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

// OAuth Schemas

/** OAuth callback request body schema (authorization code + CSRF state).
 *  Also reused verbatim by the SSO/OIDC callback (controllers/sso.ts). */
export const oauthCallbackSchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
  state: z.string().min(1, 'State parameter is required'),
});

/** SSO discovery request: is this email forced through SSO? */
export const ssoDiscoverSchema = z.object({
  email: z.string().min(3).max(320),
});

// User Schemas

/** User profile update schema (at least one field required). */
export const updateProfileSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i).optional(),
  email: emailSchema.optional(),
}).refine(data => data.username || data.email, {
  message: 'At least one field (username or email) is required',
});

/** Password change request schema. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

/** Admin user update (PUT /users/:id). Every field optional — server
 *  treats unset fields as no-ops. `organizationId: null` means "clear
 *  org assignment" (system-admin only; the controller enforces that gate).
 *  Password reuses the strict policy schema. */
export const adminUpdateUserSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i).optional(),
  email: emailSchema.optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  organizationId: z.union([z.string().min(1), z.null()]).optional(),
  password: passwordSchema.optional(),
}).strict();

/** Admin user creation (POST /users, system-admin only). Username/email/password
 *  reuse the same rules as registration (register + the User model pre-save hook)
 *  so an admin-created account is subject to the identical constraints. `role`
 *  only applies when `organizationId` is supplied. `.strict()` rejects unknown
 *  fields so nothing extra (e.g. tokenVersion) can be slipped in. */
export const adminCreateUserSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Username must contain only letters, numbers, hyphens, and underscores'),
  email: emailSchema,
  password: passwordSchema,
  isSuperAdmin: z.boolean().optional(),
  organizationId: z.string().min(1).optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(),
  // Roles are org-scoped, so any role assignment requires an organizationId
  // (enforced by the refine below + again in the service).
  roleIds: z.array(z.string()).max(50).optional(),
}).strict().refine(
  d => !(d.roleIds?.length) || !!d.organizationId,
  { message: 'organizationId is required when assigning roles', path: ['roleIds'] },
);

// Invitation Schemas

/** Invitation send request schema. */
export const sendInvitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['admin', 'member']).optional().default('member'),
  invitationType: z.enum(['email', 'oauth', 'any']).optional().default('any'),
  allowedOAuthProviders: z.array(z.enum(['google', 'github'])).optional(),
});

// Organization Schemas

/** Create organization schema (name required, tier defaults to the configured DEFAULT_QUOTA_TIER). */
export const createOrganizationSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  // Self-serve org creation may only pick a STANDARD (billing-selectable) tier —
  // NOT `unlimited` (the uncapped billing-off default), which would be a billing
  // bypass / privilege escalation. When billing is off, an omitted tier still
  // falls through to DEFAULT_TIER (= `unlimited`) via the default below.
  tier: z.enum([...STANDARD_TIERS] as [QuotaTier, ...QuotaTier[]]).optional().default(DEFAULT_TIER),
  // Org → team hierarchy: when set, create this org as a team nested under
  // `parentOrgId`. The caller must be an admin/owner of the parent (or an
  // ancestor); the parent must itself be a root org (one level of nesting).
  parentOrgId: z.string().min(1).optional(),
});

/** Reusable org slug rule: lowercase alphanumeric words joined by single
 *  hyphens (no leading/trailing/double hyphens). Mirrors the shape the
 *  Organization model auto-generates via `slugify(..., { strict: true })`. */
export const orgSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Slug must be at least 2 characters')
  .max(100, 'Slug must be at most 100 characters')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may contain only lowercase letters, numbers, and single hyphens');

/** Sysadmin organization update (`PUT /organization/:id`): name, slug and/or
 *  description. The superset of the self-serve identity edit — description is
 *  only editable here. An empty body is refused rather than silently no-op'ing. */
export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    slug: orgSlugSchema.optional(),
    description: z.string().max(500).optional(),
  })
  .refine((d) => d.name !== undefined || d.slug !== undefined || d.description !== undefined, {
    message: 'Provide a name, slug or description to update',
  });

/**
 * Update an org's impersonation policy. Either field alone is allowed; an empty
 * body is refused so a no-op PATCH can't be mistaken for a successful change.
 */
export const updateImpersonationPolicySchema = z
  .object({
    impersonationPolicy: z.enum(['open', 'consent', 'denied']).optional(),
    allowSelfApproval: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.impersonationPolicy !== undefined || d.allowSelfApproval !== undefined, {
    message: 'Provide impersonationPolicy or allowSelfApproval to update',
  });

/**
 * `PATCH /organization/:id/mfa-policy` (#8).
 *
 * `graceDays` is only meaningful while TURNING the requirement on — it is what
 * the deadline is computed from, server-side, so a client can never post a
 * deadline of its own choosing (or one in the past). Omitting it takes the
 * default; `0` makes the requirement bite immediately. `adminActionsRequireMfa`
 * is the separate "administrative actions require MFA" policy.
 */
export const updateMfaPolicySchema = z
  .object({
    requireMfa: z.boolean().optional(),
    graceDays: z.number().int().min(0).max(MAX_MFA_GRACE_DAYS).optional(),
    idpEnforcesMfa: z.boolean().optional(),
    adminActionsRequireMfa: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.requireMfa !== undefined || d.idpEnforcesMfa !== undefined || d.adminActionsRequireMfa !== undefined, {
    message: 'Provide requireMfa, idpEnforcesMfa or adminActionsRequireMfa to update',
  });

/**
 * Second leg of a sign-in whose password no longer meets the org policy: the
 * challenge handle plus the NEW password (platform rules here; the org minimum
 * and the breach check run in the controller).
 */
export const requiredPasswordChangeSchema = z.object({
  challengeId: z.string().min(1).max(256),
  newPassword: passwordSchema,
}).strict();

/**
 * PATCH /organization/:id/password-policy. `minLength: null` clears the org's
 * own minimum (back to the platform floor, or an ancestor's). The floor is the
 * platform minimum, the ceiling the platform maximum.
 */
export const updatePasswordPolicySchema = z.object({
  minLength: z.number().int().min(config.auth.passwordMinLength).max(PASSWORD_MAX_LENGTH).nullable(),
}).strict();

/**
 * PATCH /organization/:id/authenticator-policy. An empty list clears the
 * allowlist (any passkey model). Entries are AAGUIDs; normalization and the
 * all-zero refusal happen in the controller (`normalizeAaguid`).
 */
export const updateAuthenticatorPolicySchema = z.object({
  allowedAaguids: z.array(z.string().trim().min(1).max(64)).max(100),
}).strict();

/** Owner/admin self-serve org identity update (name and/or slug). At least one
 *  field must be present so an empty PATCH is rejected rather than silently
 *  no-op'ing. Reuses the sysadmin name bounds; adds the slug rule. */
export const updateOrgIdentitySchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    slug: orgSlugSchema.optional(),
  })
  .refine((d) => d.name !== undefined || d.slug !== undefined, {
    message: 'Provide a name or slug to update',
  });

/** Add member schema (either userId or email required, with optional role).
 *  `owner` is intentionally excluded — ownership only moves via
 *  transferOwnership (a second `role:'owner'` insert trips the partial-unique
 *  owner index and surfaces as an unmapped 500). */
export const addMemberSchema = z.object({
  userId: z.string().optional(),
  email: emailSchema.optional(),
  role: z.enum(['admin', 'member']).optional().default('member'),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email is required',
});

/** Bulk-add schema: add one user (by id or email) to several teams at once.
 *  `orgIds` are the target team ids; the controller/service constrain them to
 *  the context org's subtree. Capped to keep the per-request transaction bounded.
 *  `owner` excluded — see addMemberSchema. */
export const bulkAddMemberSchema = z.object({
  userId: z.string().optional(),
  email: emailSchema.optional(),
  orgIds: z.array(z.string().min(1)).min(1, 'At least one team is required').max(50),
  role: z.enum(['admin', 'member']).optional().default('member'),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email is required',
});

/** Add an existing org member to a permission role (by id or email). */
export const addRoleMemberSchema = z.object({
  userId: z.string().optional(),
  email: emailSchema.optional(),
}).refine(data => data.userId || data.email, {
  message: 'Either userId or email is required',
});

/** Create a custom permission role (name + optional description + permission set). */
export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(100).optional(),
});

/** Update a custom role. All fields optional (partial update). */
export const updateRoleSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string()).max(100).optional(),
});

// Service accounts (#2)

/** A service-account name is a machine identifier: lowercase, URL-safe, stable. */
const serviceAccountNameSchema = z.string().trim().toLowerCase().regex(
  /^[a-z0-9][a-z0-9_-]{1,63}$/,
  'name must be 2-64 characters of lowercase letters, digits, hyphen or underscore',
);

/** Create an org service account. `roleIds` are subject to the creator's ceiling. */
export const createServiceAccountSchema = z.object({
  name: serviceAccountNameSchema,
  description: z.string().trim().max(256).optional(),
  roleIds: z.array(z.string()).max(20).optional(),
  /** Token-exchange budget per quota period; -1 = unlimited. */
  tokenBudget: z.union([z.number().int().min(1), z.literal(-1)]).optional(),
});

/** Update a service account. `roleIds` REPLACES the Role set when present. */
export const updateServiceAccountSchema = z.object({
  description: z.string().trim().max(256).nullable().optional(),
  roleIds: z.array(z.string()).max(20).optional(),
  tokenBudget: z.union([z.number().int().min(1), z.literal(-1)]).optional(),
  disabled: z.boolean().optional(),
});

/** Issue a key for a service account (max 365 days; optional IP allowlist). */
export const createServiceAccountKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Lifetime in seconds. Capped at 365 days by the service. */
  expiresIn: z.number().int().min(60).max(365 * 24 * 60 * 60).optional(),
  ipAllowlist: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  /**
   * Narrow capability scope (#12). A scoped key exchanges to a least-privilege
   * token — the account's Roles are dropped in favour of this one capability —
   * so a key that only has to ingest events or push images cannot do anything
   * else with the account's authority. Validated against api-core's closed
   * {@link TOKEN_SCOPES} catalog.
   */
  scope: z.enum(TOKEN_SCOPES as unknown as [string, ...string[]]).optional(),
});

/** Organization ownership transfer schema. */
export const transferOwnershipSchema = z.object({
  newOwnerId: z.string().min(1, 'New owner ID is required'),
});

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
/** Name of the id_token claim carrying group memberships (3a). Claim names are
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

/** Which protocol the org federates over (#4). Mirrors `IdpProtocol` in
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
  /** Org policy "SSO required" (#5). Switching it ON is gated server-side on an
   *  enabled IdP, a verified domain and a successful test connection. */
  ssoRequired: z.boolean().optional(),
}).refine(
  data => !data.groupsClaim || data.protocol === 'saml' || (data.provider !== 'google' && data.provider !== 'github'),
  { message: GOOGLE_GROUPS_MESSAGE, path: ['groupsClaim'] },
);

// SAML login flow (#4)

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

// IdP group → Role mapping (3a)

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

// Org KMS Config Schema

/** Per-org KMS config PUT body: CMK id/alias + the KMS-wrapped master key
 *  (base64).
 *
 *  `keyId` accepts ONLY a bare KMS key UUID (`^[0-9a-f-]{36}$`) or an
 *  `alias/<name>` reference — a full `arn:aws:kms:...` is REJECTED. A KMS ARN
 *  embeds the 12-digit AWS account id, which would then be persisted to Mongo,
 *  written into the audit chain (`admin.org.kms-config.upsert` details), echoed
 *  in API responses, and logged. Storing the account id anywhere is a hard
 *  constraint; the ARN carries no information the provider needs (the KMS
 *  Decrypt call already knows its region), so a bare id / alias is sufficient.
 *  The regex is a cheap shape guard; the SDK does real validation on the next
 *  Decrypt. */
export const orgKmsConfigSchema = z.object({
  keyId: z.string()
    .min(1, 'keyId is required (KMS CMK key UUID or alias/<name>)')
    .refine(
      (v) => /^[0-9a-f-]{36}$/.test(v) || v.startsWith('alias/'),
      'keyId must be a bare KMS key UUID or an alias/<name> — a full ARN is rejected because it embeds the AWS account id',
    ),
  ciphertextBase64: z.string()
    .min(1, 'ciphertextBase64 is required (KMS-wrapped 32-byte master)')
    .regex(/^[A-Za-z0-9+/=]+$/, 'ciphertextBase64 must be valid base64'),
});

