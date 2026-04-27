// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import bcrypt from 'bcryptjs';
import mongoose, { Schema, Document, Types } from 'mongoose';
import { config } from '../config';

/**
 * OAuth provider data structure
 */
export interface OAuthProviderData {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  linkedAt: Date;
}

/**
 * OAuth providers map
 */
export interface OAuthProviders {
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
  /** Last organization the user interacted with. Replaces the former `organizationId` field. */
  lastActiveOrgId?: Types.ObjectId | string;
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
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
    lastActiveOrgId: {
      type: Schema.Types.Mixed,
      ref: 'Organization',
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
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
 * Validate password strength: min 8 chars, at least one uppercase, one lowercase, one digit.
 */
function validatePasswordStrength(password: string): string | null {
  if (password.length < config.auth.passwordMinLength) return `Password must be at least ${config.auth.passwordMinLength} characters`;
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
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

  const salt = await bcrypt.genSalt(config.auth.jwt.saltRounds);
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
