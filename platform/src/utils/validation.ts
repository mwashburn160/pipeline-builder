// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, STANDARD_TIERS, TOKEN_SCOPES, sendError, type QuotaTier } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { z } from 'zod';
import { EMAIL_PATTERN } from './email-address.js';
import { config } from '../config/index.js';
import { PASSWORD_RULES } from '../models/user.js';

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
  z.string().min(config.auth.passwordMinLength).max(128),
);

// Auth Schemas

/** Registration request body schema. */
export const registerSchema = z.object({
  username: z.string().min(2).max(30).regex(/^[a-z0-9_-]+$/i, 'Username must contain only letters, numbers, hyphens, and underscores'),
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string().min(2).max(100).optional(),
  planId: z.string().optional(),
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

/** Organization update schema (name and/or description). */
export const updateOrganizationSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
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

/** Owner/admin self-serve org identity update (name and/or slug). At least one
 *  field must be present so an empty PATCH is rejected rather than silently
 *  no-op'ing. Reuses the sysadmin name bounds; adds the slug rule. */
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

/** Quota limits update schema (values can be numbers or 'unlimited'). */
export const updateQuotasSchema = z.object({
  plugins: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  pipelines: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  apiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
  aiCalls: z.union([z.number().int().min(-1), z.literal('unlimited')]).optional(),
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

export const orgIdpCreateSchema = z.object({
  orgId: z.string().min(1),
  provider: idpProviderSchema,
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryUrl: z.string().optional(),
  region: awsRegionSchema.optional(),
  userPoolId: userPoolIdSchema.optional(),
  /** Empty string means "no groups claim" — the editor sends it to clear the
   *  field (and always sends it for a provider that has no groups). */
  groupsClaim: z.union([groupsClaimSchema, z.literal('')]).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
}).refine(
  data => data.provider !== 'generic-oidc' || !!data.discoveryUrl,
  { message: 'discoveryUrl is required for generic-oidc provider', path: ['discoveryUrl'] },
).refine(
  data => data.provider !== 'cognito' || (!!data.region && !!data.userPoolId),
  { message: 'region and userPoolId are required for cognito provider', path: ['userPoolId'] },
).refine(
  data => !data.groupsClaim || (data.provider !== 'google' && data.provider !== 'github'),
  { message: GOOGLE_GROUPS_MESSAGE, path: ['groupsClaim'] },
);

/** Partial update of an org IdP config. Every field optional; unset fields
 *  are left untouched by the service. */
export const orgIdpPatchSchema = z.object({
  provider: idpProviderSchema.optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  discoveryUrl: z.string().optional(),
  region: awsRegionSchema.optional(),
  userPoolId: userPoolIdSchema.optional(),
  /** Empty string CLEARS the claim back to the `groups` default. */
  groupsClaim: z.union([groupsClaimSchema, z.literal('')]).optional(),
  allowedEmailDomains: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
}).refine(
  data => !data.groupsClaim || (data.provider !== 'google' && data.provider !== 'github'),
  { message: GOOGLE_GROUPS_MESSAGE, path: ['groupsClaim'] },
);

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

