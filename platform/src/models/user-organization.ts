import { Schema, model, Document, Types } from 'mongoose';

/**
 * Membership role within an organization.
 * - owner: created the org or received ownership transfer
 * - admin: can manage members and org settings
 * - member: standard access
 */
export type OrgMemberRole = 'owner' | 'admin' | 'member';

/**
 * UserOrganization document interface.
 * Junction collection linking users to organizations with per-org roles.
 */
export interface UserOrganizationDocument extends Document {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId | string;
  role: OrgMemberRole;
  isActive: boolean;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userOrganizationSchema = new Schema<UserOrganizationDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    organizationId: {
      type: Schema.Types.Mixed,
      ref: 'Organization',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    joinedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// Prevent duplicate memberships
userOrganizationSchema.index({ userId: 1, organizationId: 1 }, { unique: true });

// List active members of an org, optionally filtered by role
userOrganizationSchema.index({ organizationId: 1, isActive: 1, role: 1 });

// List all orgs for a user
userOrganizationSchema.index({ userId: 1 });

export default model<UserOrganizationDocument>('UserOrganization', userOrganizationSchema);
