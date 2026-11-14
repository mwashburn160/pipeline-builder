// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { config } from '../config/index.js';
import { ORG_ROLES, type OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import { INVITATION_STATUSES, INVITATION_TYPES, type InvitationStatus, type InvitationType } from '../constants/vocabulary.js';
import { type OAuthProviderName, OAUTH_PROVIDER_NAMES } from '../types/oauth-provider.js';

/**
 * Invitation document interface
 */
export interface InvitationData {
  email: string;
  organizationId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  role: OrgRole;
  /**
   * Roles assigned on acceptance, on top of the baseline the coarse `role`
   * gives. Empty or absent for an invitation that grants nothing beyond it.
   *
   * WHY IT IS HERE. The invitation carried only the coarse admin/member word,
   * so onboarding anyone into a job — Developer, Billing Manager, Security
   * Officer — meant inviting them as ADMIN (every org-assignable permission,
   * `roles:manage` and `org_kms:write` included) and demoting afterwards, or
   * inviting as member and remembering to assign later. The user-admin API has
   * taken `roleIds` all along; the invitation is the path that had not.
   *
   * The inviter's ceiling is checked when the invitation is SENT and again when
   * it is accepted — an invitation can sit pending for days, and the person who
   * sent it may have lost the authority meanwhile.
   */
  roleIds?: Types.ObjectId[];
  token: string;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: Types.ObjectId;

  // OAuth-specific fields
  invitationType: InvitationType;
  allowedOAuthProviders?: OAuthProviderName[];
  acceptedVia?: 'email' | OAuthProviderName;

  createdAt: Date;
  updatedAt: Date;

}

/** Instance methods of a Invitation document. */
export interface InvitationMethods {
  isExpired(): boolean;
  isValid(): boolean;
  canAcceptViaOAuth(provider: OAuthProviderName): boolean;
  canAcceptViaEmail(): boolean;
}

export type InvitationDocument = HydratedDocument<InvitationData, InvitationMethods>;
type InvitationModel = Model<InvitationData, object, InvitationMethods>;

const invitationSchema = new Schema<InvitationData, InvitationModel, InvitationMethods>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: [...ORG_ROLES],
      default: 'member',
    },
    roleIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Role' }],
      default: undefined,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: [...INVITATION_STATUSES],
      default: 'pending',
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    acceptedAt: {
      type: Date,
    },
    acceptedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },

    // OAuth-specific fields
    invitationType: {
      type: String,
      enum: [...INVITATION_TYPES],
      default: 'any',
    },
    allowedOAuthProviders: {
      type: [String],
      enum: [...OAUTH_PROVIDER_NAMES],
      default: undefined,
    },
    acceptedVia: {
      type: String,
      enum: ['email', ...OAUTH_PROVIDER_NAMES],
    },
  },
  {
    timestamps: true,
    collection: 'invitations',
  },
);

/**
 * Generate secure invitation token before saving
 */
invitationSchema.pre('validate', function () {
  if (!this.token) {
    this.token = crypto.randomBytes(32).toString('hex');
  }
  if (!this.expiresAt) {
    this.expiresAt = new Date(Date.now() + config.invitation.expirationDays * 24 * 60 * 60 * 1000);
  }
});

/**
 * Check if invitation is expired
 */
invitationSchema.methods.isExpired = function (): boolean {
  return new Date() > this.expiresAt;
};

/**
 * Check if invitation is valid (pending and not expired)
 */
invitationSchema.methods.isValid = function (): boolean {
  return this.status === 'pending' && !this.isExpired();
};

/**
 * Check if invitation can be accepted via specific OAuth provider
 */
invitationSchema.methods.canAcceptViaOAuth = function (provider: OAuthProviderName): boolean {
  if (!this.isValid()) return false;

  // If invitation type is email-only, OAuth is not allowed
  if (this.invitationType === 'email') return false;

  // If specific providers are defined, check if this provider is allowed
  if (this.allowedOAuthProviders && this.allowedOAuthProviders.length > 0) {
    return this.allowedOAuthProviders.includes(provider);
  }

  // Default: allow all OAuth providers for 'any' or 'oauth' type
  return true;
};

/**
 * Check if invitation can be accepted via email/password
 */
invitationSchema.methods.canAcceptViaEmail = function (): boolean {
  if (!this.isValid()) return false;

  // If invitation type is oauth-only, email is not allowed
  if (this.invitationType === 'oauth') return false;

  return true;
};

/**
 * Compound index for finding pending invitations
 */
invitationSchema.index({ organizationId: 1, email: 1, status: 1 });

export default model<InvitationData, InvitationModel>('Invitation', invitationSchema);
