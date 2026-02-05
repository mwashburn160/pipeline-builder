import crypto from 'crypto';
import { Schema, model, Document, Types } from 'mongoose';

/**
 * Invitation status
 */
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * OAuth provider type for invitations
 */
export type InvitationOAuthProvider = 'google';

/**
 * Invitation type - how the invitation can be accepted
 */
export type InvitationType = 'email' | 'oauth' | 'any';

/**
 * Invitation document interface
 */
export interface IInvitation extends Document {
  _id: Types.ObjectId;
  email: string;
  organizationId: Types.ObjectId;
  invitedBy: Types.ObjectId;
  role: 'user' | 'admin';
  token: string;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: Types.ObjectId;

  // OAuth-specific fields
  invitationType: InvitationType;
  allowedOAuthProviders?: InvitationOAuthProvider[];
  acceptedVia?: 'email' | InvitationOAuthProvider;

  createdAt: Date;
  updatedAt: Date;

  isExpired(): boolean;
  isValid(): boolean;
  canAcceptViaOAuth(provider: InvitationOAuthProvider): boolean;
  canAcceptViaEmail(): boolean;
}

const invitationSchema = new Schema<IInvitation>(
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
      enum: ['user', 'admin'],
      default: 'user',
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'expired', 'revoked'],
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
      enum: ['email', 'oauth', 'any'],
      default: 'any',
    },
    allowedOAuthProviders: {
      type: [String],
      enum: ['google'],
      default: undefined,
    },
    acceptedVia: {
      type: String,
      enum: ['email', 'google'],
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
    // Default expiration: 7 days
    this.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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
invitationSchema.methods.canAcceptViaOAuth = function (provider: InvitationOAuthProvider): boolean {
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

export default model<IInvitation>('Invitation', invitationSchema);
