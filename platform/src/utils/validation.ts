// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_TIER, STANDARD_TIERS, TOKEN_SCOPES, sendError, type QuotaTier } from '@pipeline-builder/api-core';
import type { Response } from 'express';
import { z } from 'zod';
import { EMAIL_PATTERN } from './email-address.js';
import { config } from '../config/index.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_RULES } from '../constants/password.js';
import { MAX_ALLOWED_AAGUIDS } from '../helpers/authenticator-policy.js';
import { MAX_MFA_GRACE_DAYS, MFA_RESET_GRACE_MAX_HOURS } from '../helpers/mfa-policy.js';

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
  /** Error code per top-level field, for a route whose clients branch on it
   *  (default `VALIDATION_ERROR`). */
  codes?: Record<string, string>,
): T | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const firstIssue = result.error.issues[0];
  const message = firstIssue
    ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
    : 'Validation failed';
  const code = (firstIssue && codes?.[String(firstIssue.path[0])]) || 'VALIDATION_ERROR';
  sendError(res, 400, message, code);
  return null;
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
const orgSlugSchema = z
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
 * `PATCH /organization/:id/mfa-policy`.
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
  allowedAaguids: z.array(z.string().trim().min(1).max(64)).max(MAX_ALLOWED_AAGUIDS),
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

// Service accounts

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
   * Narrow capability scope. A scoped key exchanges to a least-privilege
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


// Second factors: authenticator app, passkeys, MFA reset

/**
 * A code, generated or recovery, as typed. Loose on purpose — the service is
 * what decides whether six digits or a `XXXXX-XXXXX` recovery code verifies, and
 * a stricter schema here would leak WHICH kind was expected through the
 * validation error.
 */
export const totpCodeSchema = z.object({ code: z.string().trim().min(6).max(32) });

/** The sign-in second leg: the challenge handle plus the code. */
export const mfaVerifySchema = totpCodeSchema.extend({ challengeId: z.string().min(1).max(256) });

/**
 * A WebAuthn authenticator's reply, forwarded verbatim from
 * `@simplewebauthn/browser`. Validated only for SHAPE — the library re-parses
 * and cryptographically verifies every field, so re-describing the WebAuthn
 * schema here would be a second source of truth that could only drift.
 */
export const webauthnCeremonySchema = z.object({
  ceremonyId: z.string().min(1).max(256),
  response: z.object({ id: z.string().min(1).max(512) }).passthrough(),
});

export const webauthnRegisterVerifySchema = webauthnCeremonySchema.extend({
  name: z.string().trim().min(1).max(64),
});

export const passkeyRenameSchema = z.object({ name: z.string().trim().min(1).max(64) });

const mfaResetUserId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a user id');
const mfaResetReason = z.string().trim().min(10, 'give a reason of at least 10 characters').max(500);
const mfaResetGraceHours = z.number().int().min(1).max(MFA_RESET_GRACE_MAX_HOURS).optional();

/** Two-person MFA reset: the request, its approval / denial, and the sysadmin's direct reset. */
export const mfaResetRequestSchema = z.object({ userId: mfaResetUserId, reason: mfaResetReason }).strict();
export const mfaResetApproveSchema = z.object({ graceHours: mfaResetGraceHours }).strict();
export const mfaResetDenySchema = z.object({ note: z.string().trim().max(500).optional() }).strict();
export const mfaResetDirectSchema = z.object({ reason: mfaResetReason, graceHours: mfaResetGraceHours }).strict();

/** Step-up re-auth through a linked social provider or the org's SSO. */
export const stepUpReauthStartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth'), provider: z.string().min(1).max(40) }),
  z.object({ type: z.literal('sso'), orgId: z.string().min(1).max(64) }),
]);

/** Completion of an SSO test connection (a dry run that opens no session). */
export const ssoTestCompleteSchema = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096).optional(),
  /** The IdP's `?error=` when it refused (OIDC). */
  error: z.string().max(256).optional(),
});

// Access keys (pre-auth: the key in the body IS the credential)

const presentedKey = z.string({ message: 'is required' }).trim().min(1, 'is required');

/** The field → error code the key routes answer with, which the CLI branches on. */
export const ACCESS_KEY_BODY_CODES = { key: 'INVALID_ACCESS_KEY', expiresIn: 'INVALID_EXPIRES_IN', keyId: 'INVALID_KEY_ID' };

/** POST /auth/token/exchange. */
export const tokenExchangeSchema = z.object({ key: presentedKey });

/** POST /auth/key/rotate — a service-account key mints its own replacement. */
export const keyRotateSchema = z.object({
  key: presentedKey,
  /** Blank means "keep the presented key's name". */
  name: z.unknown().optional().transform((v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined)),
  expiresIn: z.union([z.number(), z.string()]).optional()
    .transform((v) => (v === undefined ? undefined : Number.parseInt(String(v), 10)))
    .refine((v) => v === undefined || Number.isFinite(v), 'must be a positive integer (seconds)'),
});

/** POST /auth/key/revoke — retire a sibling key with the live one. */
export const keyRevokeSchema = z.object({
  key: presentedKey,
  keyId: z.string({ message: 'is required' }).trim().min(1, 'is required'),
});

// Internal notices

/** POST /internal/notify-email (compliance): email an org's users. */
export const notifyEmailSchema = z.object({
  orgId: z.string({ message: 'is required' }).min(1, 'is required'),
  subject: z.string({ message: 'is required' }).min(1, 'is required'),
  text: z.string({ message: 'is required' }).min(1, 'is required'),
  /** Specific recipients; non-strings are dropped, absent means the org's admins. */
  targetUsers: z.unknown().optional().transform((v) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : null)),
});
