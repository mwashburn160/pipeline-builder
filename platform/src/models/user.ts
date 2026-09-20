// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AssuranceLevel, AuthMethod } from '@pipeline-builder/api-core';
import bcrypt from 'bcryptjs';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { config } from '../config/index.js';

/**
 * OAuth provider data structure. Internal to the user model — the user-
 * profile API returns a flattened shape, so external consumers shouldn't
 * import this directly.
 */
interface OAuthProviderData {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  /** Set for SSO links only: the IdP's `iss`. An SSO subject is matched only
   *  together with it, because an org admin controls the subjects its IdP mints. */
  issuer?: string;
  linkedAt: Date;
}

/**
 * OAuth providers map. Internal to the user model (see above).
 */
interface OAuthProviders {
  'google'?: OAuthProviderData;
  'github'?: OAuthProviderData;
  'facebook'?: OAuthProviderData;
  'microsoft'?: OAuthProviderData;
  'gitlab'?: OAuthProviderData;
  'linkedin'?: OAuthProviderData;
  // Per-org SSO (OIDC) providers also persist linkage here — findOrCreateOAuthUser
  // is shared by the social-login and SSO callbacks and keys on the IdP provider.
  // `google`/`github` above double as SSO keys; these two are SSO-only.
  'generic-oidc'?: OAuthProviderData;
  'cognito'?: OAuthProviderData;
  /** SAML 2.0 SSO (#4). One key for every SAML IdP: a SAML config has no named
   *  provider, and the link is only ever matched together with its `issuer`
   *  (the IdP's entity id), so two orgs on SAML never collide here. */
  'saml'?: OAuthProviderData;
}

/**
 * - `interactive` — a person signed in (password, OAuth, SSO). Renewed by
 *   POST /auth/refresh; capped at `MAX_REFRESH_SESSIONS`, oldest pushed out.
 * - `machine` — a stored credential opened by POST /user/generate-token (e.g.
 *   `pipeline-manager infra store-token`). Renewed only by generate-token from
 *   the slot's own token; never refreshable; capped separately, least recently
 *   used evicted.
 */
export type RefreshSessionKind = 'interactive' | 'machine';

/** A signed-in device's (or stored machine credential's) refresh-token slot. */
export interface RefreshSession {
  /** Stable slot id, carried as `sid` in that session's access + refresh tokens. */
  id: string;
  kind: RefreshSessionKind;
  /** SHA-256 of the slot's current refresh token. */
  hash: string;
  createdAt: Date;
  /** Last refresh / renewal / switch-org. */
  lastUsedAt: Date;
  /** Capability scope of the tokens this slot mints (a narrow machine credential).
   *  Stored server-side so renewal can never widen it. */
  scope?: string;
  /** Permission SUBSET of a permission-scoped machine token (catalog ids). Stored
   *  server-side so renewal re-intersects it with the holder's current
   *  permissions and can never widen it. Absent = full permissions. */
  permissions?: string[];
  /** AAGUID of the passkey that opened a `webauthn` session, so every issuance
   *  can re-apply the active org's authenticator allowlist. */
  aaguid?: string;
  /** Authentication methods of the sign-in that opened the slot (JWT `amr`). */
  amr: AuthMethod[];
  /** Assurance level of that sign-in (JWT `aal`). Never raised by renewal. */
  aal: AssuranceLevel;
  /** The slot is a BOOTSTRAP-ADMIN ENROLMENT session (#8): it may reach only
   *  enrolment, sign-out and the setup routes. Stored here, not derived per
   *  token, so a refresh of the slot stays exactly as limited. */
  mfaEnrollmentPending?: boolean;
  /** When that sign-in happened (JWT `auth_time`). Never reset by renewal. */
  authTime: Date;
  /** Short client summary ("Chrome on macOS") from the User-Agent — no raw header. */
  userAgent?: string;
  /** Last IP the slot was used from. Personal data: kept only for the slot's
   *  life (dropped with the slot and with the user document); no geolocation. */
  lastIp?: string;
}

/**
 * User document interface.
 *
 * Users can belong to multiple organizations via the {@link UserOrganization}
 * junction collection. The `lastActiveOrgId` field tracks which organization
 * the user last interacted with (used as a default when issuing tokens).
 *
 * There is no global `role` on the User model -- roles are per-organization
 * and stored in UserOrganization (see `models/user-organization.ts`).
 */
export interface UserDocument extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password?: string;
  /**
   * Last organization the user interacted with. Stored as a string for
   * predictable indexing — values are either an ObjectId hex (24 chars) or
   * the literal `'system'`. Replaces the former `organizationId` field.
   */
  lastActiveOrgId?: string;
  isEmailVerified: boolean;
  /**
   * First-run flag. Set true only when a brand-new identity is auto-provisioned
   * through social OAuth (no org name / plan was ever collected — see
   * `authService.findOrCreateOAuthUser`). The frontend gate routes such users
   * through the onboarding screen and `authService.completeOnboarding` clears it.
   * Email/password registration and SSO-provisioned users are never flagged
   * (they either supply an org name or belong to an enforced org).
   */
  needsOnboarding?: boolean;
  /** The org auto-provisioned for this user at social signup. `completeOnboarding`
   *  renames exactly this org (not whatever `lastActiveOrgId` happens to be, in
   *  case the user switched active org before finishing onboarding). */
  onboardingOrgId?: string;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  /**
   * Global super-admin flag. When true, this user is a Pipeline Builder
   * operator and `isSystemAdmin()` returns true regardless of which org
   * they're currently scoped to. Replaces "membership in the well-known
   * 'system' org" as the canonical sysadmin signal; both still work during
   * the rollout. New ops users should get this flag instead of being
   * added to the system org.
   *
   * Hide from default queries — operators can't grant themselves this via
   * the user-profile API; it's set out-of-band (db update) or via a
   * dedicated sysadmin-only endpoint (future).
   *
   * The schema field uses `select: false`, so callers that need to consult
   * this flag MUST explicitly opt in: `User.findById(id).select('+isSuperAdmin')`.
   * Reads via a default `.find()` will return the document without the field,
   * which is the safer default — code paths that haven't been audited for
   * sysadmin handling can't accidentally elevate.
   */
  isSuperAdmin?: boolean;
  tokenVersion: number;
  /** One refresh-token slot per signed-in device or stored machine credential,
   *  oldest first (each kind capped — see `MAX_REFRESH_SESSIONS`). Only the SHA-256 of the current token is stored.
   *  Rotation swaps a slot's hash; reuse of a rotated token revokes that slot. */
  refreshSessions?: RefreshSession[];
  /** Last 20 access tokens issued for this user. Append-only ring; capped at 20.
   *  Used to surface a token-history view on the dashboard. */
  issuedTokens?: Array<{
    id: string;
    createdAt: Date;
    expiresAt: Date;
    /** Token-version at issuance — if it differs from `User.tokenVersion`, the token has been revoked by an "invalidate all" action. */
    tokenVersionAtIssue: number;
  }>;
  featureOverrides?: Map<string, boolean>;
  oauth?: OAuthProviders;
  /**
   * Opaque WebAuthn user handle (32 random bytes, base64url), minted lazily the
   * first time the account registers a passkey.
   *
   * It is what the authenticator stores alongside a discoverable credential and
   * hands back on passkey sign-in, so it MUST NOT be the Mongo `_id`: that id
   * appears in URLs and audit rows, and the handle is meant to be opaque and
   * non-correlatable across relying parties. Hidden from default queries — only
   * the WebAuthn service ever reads it.
   */
  webauthnUserId?: string;
  /**
   * When the BOOTSTRAP-ADMIN MFA exception closed for this account (#8).
   *
   * A fresh install has exactly one admin and no enrolled factor, so requiring
   * MFA would lock out the only person who can enrol one. Until this is set, a
   * bootstrap admin's password sign-in yields an `aal: 1` session flagged
   * `mfaEnrollmentPending` that can reach only enrolment, sign-out and the setup
   * routes. Stamped the FIRST time any factor is enrolled — and never cleared,
   * not even when that factor is later removed, because the account demonstrably
   * had a way to enrol one and re-opening the hole would make it permanent by
   * another name. Recovery after losing every factor is an operator command run
   * with database access (`platform/src/scripts/mfa-recover.ts`), not a route.
   */
  mfaBootstrapClosedAt?: Date;
  /**
   * Per-user MFA ENROLMENT GRACE after an approved MFA reset
   * (`services/mfa-recovery.ts`). Until it passes, the org's "require MFA"
   * policy (own or inherited) does not refuse this person's single-factor
   * sessions at issuance, so they can sign in and enrol a new factor — without
   * the org's policy being weakened for anyone else. Cleared on the first new
   * enrolment; never extends the admin-actions policy (`org_admin_aal`).
   */
  mfaResetGraceUntil?: Date;
  /**
   * When the account last asked NOT to be prompted to protect itself (the
   * password-only prompt — `helpers/mfa-nudge.ts`).
   *
   * MFA state itself is DERIVED — an account is protected because it holds a
   * passkey or a confirmed authenticator enrolment, never because a flag says
   * so — so there is deliberately no "MFA enabled" boolean anywhere near this.
   * What IS a real preference is whether we keep asking, and that has to
   * survive a sign-out or the prompt is back on the next login, which is how
   * people learn to dismiss a banner without reading it.
   *
   * It lives on the USER rather than in `UserPreferences` because factors are
   * an ACCOUNT fact: `UserPreferences` is keyed `(userId, organizationId)`, so
   * a snooze taken in one org would not be honoured in another and a decline
   * would be invisible to every org but the one it was made in — including to
   * the admin count that reports it. Two more consequences follow: the profile
   * read already loads this document (so the prompt costs no extra query, and
   * works for a bootstrap-admin enrolment session, which may read
   * `/user/profile` and nothing else), and enrolment can clear it in one write.
   *
   * Cleared on the first enrolment of any factor, so removing that factor later
   * leaves no stale suppression behind (`helpers/mfa-nudge.ts`).
   */
  mfaNudge?: {
    /** Prompt suppressed until this moment ("Not now"). */
    snoozedUntil?: Date;
    /** The person asked never to be prompted again. Reversible by them. */
    declinedAt?: Date;
  };
  comparePassword(password: string): Promise<boolean>;
}

const oauthProviderSchema = new Schema<OAuthProviderData>(
  {
    id: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String },
    picture: { type: String },
    issuer: { type: String },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSchema = new Schema<UserDocument>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      select: false,
    },
    // `String` (not `Mixed`) so MongoDB indexes / equality queries behave
    // predictably; the value is always a 24-char ObjectId hex (the system org is
    // now an ObjectId too — no string sentinel). The validator rejects anything
    // else so a stray write can't park the user on a non-existent org.
    lastActiveOrgId: {
      type: String,
      ref: 'Organization',
      index: true,
      validate: {
        validator: (v: unknown) =>
          v === null
          || v === undefined
          || (typeof v === 'string' && mongoose.isValidObjectId(v)),
        message: 'lastActiveOrgId must be an ObjectId',
      },
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    needsOnboarding: {
      type: Boolean,
      default: false,
    },
    onboardingOrgId: {
      type: String,
    },
    isSuperAdmin: {
      type: Boolean,
      default: false,
      // Indexed because token-issuance hot-path reads it on every login.
      index: true,
      // Hidden from default queries — see the interface JSDoc above.
      // Callers must `.select('+isSuperAdmin')` to read it.
      select: false,
    },
    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpires: {
      type: Date,
      select: false,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
    refreshSessions: {
      type: [{
        _id: false,
        id: { type: String, required: true },
        kind: { type: String, enum: ['interactive', 'machine'], required: true },
        hash: { type: String, required: true },
        createdAt: { type: Date, required: true },
        lastUsedAt: { type: Date, required: true },
        scope: { type: String },
        permissions: { type: [String], default: undefined },
        aaguid: { type: String },
        amr: { type: [String], required: true },
        aal: { type: Number, enum: [1, 2], required: true },
        mfaEnrollmentPending: { type: Boolean },
        authTime: { type: Date, required: true },
        userAgent: { type: String },
        lastIp: { type: String },
      }],
      default: [],
      select: false,
    },
    issuedTokens: {
      type: [{
        _id: false,
        id: { type: String, required: true },
        createdAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        tokenVersionAtIssue: { type: Number, required: true },
      }],
      default: [],
    },
    featureOverrides: {
      type: Map,
      of: Boolean,
      // Factory — without this every doc shares the same Map instance.
      default: () => new Map(),
    },
    webauthnUserId: {
      type: String,
      // Never selected by accident — the only reader is the WebAuthn service.
      select: false,
      // Sparse: almost no account has one until it registers a passkey.
      index: { unique: true, sparse: true },
    },
    // Bootstrap-admin MFA exception, closed (see the interface JSDoc). No
    // `select: false`: the login path must read it on every sign-in, and its
    // value reveals nothing.
    mfaBootstrapClosedAt: {
      type: Date,
    },
    // Per-user MFA enrolment grace after an approved reset (see the interface
    // JSDoc). Read on every issuance, like the field above.
    mfaResetGraceUntil: {
      type: Date,
    },
    // "Stop asking me to protect this account" (see the interface JSDoc). Read
    // on every profile read, and never a statement about whether MFA is ON —
    // that is only ever the enrolled factors.
    mfaNudge: {
      type: new Schema(
        { snoozedUntil: { type: Date }, declinedAt: { type: Date } },
        { _id: false },
      ),
      // No default: an account that was never prompted carries no subdocument,
      // which is what "never asked" looks like in the profile payload.
      default: undefined,
    },
    oauth: {
      'google': oauthProviderSchema,
      'github': oauthProviderSchema,
      'facebook': oauthProviderSchema,
      'microsoft': oauthProviderSchema,
      'gitlab': oauthProviderSchema,
      'linkedin': oauthProviderSchema,
      // SSO (OIDC) provider keys — see OAuthProviders. Without these, per-org SSO
      // linkage was silently dropped under Mongoose strict mode and every SSO
      // login re-matched by email instead of the oauth-id fast path.
      'generic-oidc': oauthProviderSchema,
      'cognito': oauthProviderSchema,
      // SAML 2.0 SSO (#4) — subject is the assertion's NameID, issuer the IdP's
      // entity id. Same strict-mode reason as the two above.
      'saml': oauthProviderSchema,
    },
  },
  { timestamps: true },
);

/**
 * Password complexity rules — single source of truth.
 *
 * Both the Mongoose `pre('save')` hook below AND the request-body Zod
 * schema in `utils/validation.ts` (`passwordSchema`) MUST evaluate the
 * same rules so a value that passes API validation never trips the model
 * hook (and vice versa). Exporting the regexes here lets the validation
 * module import them instead of re-typing the patterns.
 *
 * Length minimum comes from `config.auth.passwordMinLength` so it's tunable
 * per environment without a code change.
 */
/** Hard ceiling on any password (and on an org's minimum). bcrypt reads only
 *  72 bytes, and an unbounded value is a hashing DoS. Not configurable. */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES: ReadonlyArray<{ test: RegExp; message: string }> = [
  { test: /[A-Z]/, message: 'Password must contain at least one uppercase letter' },
  { test: /[a-z]/, message: 'Password must contain at least one lowercase letter' },
  { test: /[0-9]/, message: 'Password must contain at least one digit' },
];

/**
 * Validate password strength. Returns the first violation message or `null`
 * if the value satisfies every rule in `PASSWORD_RULES` and meets the
 * configured minimum length.
 */
function validatePasswordStrength(password: string): string | null {
  if (password.length < config.auth.passwordMinLength) {
    return `Password must be at least ${config.auth.passwordMinLength} characters`;
  }
  for (const rule of PASSWORD_RULES) {
    if (!rule.test.test(password)) return rule.message;
  }
  return null;
}

/**
 * Validate and hash password before saving
 */
userSchema.pre<UserDocument>('save', async function () {
  if (!this.isModified('password') || !this.password) return;

  const strengthError = validatePasswordStrength(this.password);
  if (strengthError) {
    throw new Error(strengthError);
  }

  const salt = await bcrypt.genSalt(config.auth.passwordSaltRounds);
  this.password = await bcrypt.hash(this.password, salt);
});

/**
 * Compare password with hash
 */
userSchema.methods.comparePassword = async function (password: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

/**
 * Indexes
 */
userSchema.index({ 'oauth.google.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.github.id': 1 }, { sparse: true });
// Same login-lookup index for the other social providers — findOrCreateOAuthUser
// queries `oauth.<provider>.id` for every provider, so without these the lookup
// is a full `users` collection scan on each facebook/microsoft/gitlab/linkedin login.
userSchema.index({ 'oauth.facebook.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.microsoft.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.gitlab.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.linkedin.id': 1 }, { sparse: true });
// SSO (OIDC) provider keys — same login-lookup fast path (google/github indexes above cover the SSO providers that reuse those keys).
userSchema.index({ 'oauth.generic-oidc.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.cognito.id': 1 }, { sparse: true });
userSchema.index({ email: 1, username: 1 }); // login lookup: email OR username

export default mongoose.model<UserDocument>('User', userSchema);
