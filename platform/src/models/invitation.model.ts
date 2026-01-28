import crypto from 'crypto';
import { Schema, model, Document, Types } from 'mongoose';

/**
 * Invitation status
 */
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

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
  createdAt: Date;
  updatedAt: Date;
  isExpired(): boolean;
  isValid(): boolean;
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
 * Compound index for finding pending invitations
 */
invitationSchema.index({ organizationId: 1, email: 1, status: 1 });

export default model<IInvitation>('Invitation', invitationSchema);
