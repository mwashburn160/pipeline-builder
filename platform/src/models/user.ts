// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

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
  linkedAt: Date;
}

/**
 * OAuth providers map. Internal to the user model (see above).
 */
interface OAuthProviders {
  google?: OAuthProviderData;
  github?: OAuthProviderData;
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
  refreshToken?: string;
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
  comparePassword(password: string): Promise<boolean>;
  invalidateAllSessions(): Promise<UserDocument>;
}

const oauthProviderSchema = new Schema<OAuthProviderData>(
  {
    id: { type: String, required: true },
    email: { type: String, required: true },
    name: { type: String },
    picture: { type: String },
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
    refreshToken: {
      type: String,
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
    oauth: {
      google: oauthProviderSchema,
      github: oauthProviderSchema,
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
 * Invalidate all user sessions by incrementing token version
 */
userSchema.methods.invalidateAllSessions = async function (): Promise<UserDocument> {
  this.tokenVersion += 1;
  return this.save();
};

/**
 * Indexes
 */
userSchema.index({ 'oauth.google.id': 1 }, { sparse: true });
userSchema.index({ 'oauth.github.id': 1 }, { sparse: true });
userSchema.index({ email: 1, username: 1 }); // login lookup: email OR username

export default mongoose.model<UserDocument>('User', userSchema);
