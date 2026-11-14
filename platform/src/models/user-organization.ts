// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, Types, type HydratedDocument } from 'mongoose';
import { ORG_ROLES, type OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';

/**
 * Directory-owned state for ONE membership, written only by the SCIM endpoints.
 * It lives on the membership rather than on `User` on purpose: a person can
 * belong to several orgs, each with its own identity provider, and a tenant's
 * directory must never be able to rewrite the platform ACCOUNT (its email,
 * username or sign-in) of someone who also belongs elsewhere. Everything here is
 * per-org, display-or-correlation only, and grants nothing by itself.
 */
export interface ScimMembershipState {
  /** The directory's own id for this person (SCIM `externalId`) — the handle the
   *  IdP correlates on when the local `userName` changes. */
  externalId?: string | null;
  /** `userName` exactly as the IdP sends it (an email or a UPN). The platform
   *  identity stays `User.email`; this is what an `userName eq` filter matches. */
  userName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  displayName?: string | null;
  /**
   * Lowercased group keys (`IdpGroupMapping.groupKey`) the directory currently
   * puts this member in. THE source for a SCIM-driven Role sync: the keys resolve
   * through the same `resolveMappedRoles` the SSO sign-in path uses, and the
   * resulting assignments are `source: 'jit'`, so a hand-granted Role is never
   * removed by a sync.
   */
  groups?: string[];
  /** True once a SCIM client created or claimed this membership. */
  managed?: boolean;
  /** When a SCIM write last touched this membership. */
  lastSyncedAt?: Date | null;
}

/**
 * UserOrganization document interface.
 * Junction collection linking users to organizations with per-org roles.
 */
export interface UserOrganizationData {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  role: OrgRole;
  isActive: boolean;
  joinedAt: Date;
  /**
   * When this member last opened a session in this organization.
   *
   * The ONLY new instrumentation the expansion-offers plan requires
   * (docs/plans/sales-agent.md D4 Class 3), and it is a DISQUALIFIER rather
   * than a sales signal: an account at 95% of its seat cap whose members have
   * not signed in is a churn save, not an expansion, and offering it more seats
   * is the worst available outcome. Without this the seat offer cannot tell
   * those two accounts apart.
   *
   * Stamped at most once a day per membership (see `stampMembershipActivity`),
   * so it costs no write on the hot path. Absent means "not since this field
   * shipped", which the profile reads as unknown rather than as inactive —
   * treating a missing stamp as idle would suppress every offer for a period.
   */
  lastActiveAt?: Date;
  /** Present only on memberships an IdP's SCIM client has touched. */
  scim?: ScimMembershipState;
  createdAt: Date;
  updatedAt: Date;
}

export type UserOrganizationDocument = HydratedDocument<UserOrganizationData>;

const userOrganizationSchema = new Schema<UserOrganizationData>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    role: {
      type: String,
      enum: [...ORG_ROLES],
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
    // No default: absent means "not seen since this field shipped", which the
    // offers profile reads as UNKNOWN. Defaulting it to now would mark every
    // existing membership active without evidence, which is the direction that
    // argues FOR a seat offer the account may not want.
    lastActiveAt: { type: Date, default: undefined },
    // SCIM. Absent until an IdP's SCIM client writes the membership; no
    // sub-document default, so a membership created by any other path stays
    // exactly as it was.
    scim: {
      type: new Schema<ScimMembershipState>(
        {
          externalId: { type: String, default: null, maxlength: 256 },
          userName: { type: String, default: null, maxlength: 254 },
          givenName: { type: String, default: null, maxlength: 128 },
          familyName: { type: String, default: null, maxlength: 128 },
          displayName: { type: String, default: null, maxlength: 256 },
          groups: { type: [String], default: [] },
          managed: { type: Boolean, default: false },
          lastSyncedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      required: false,
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

// Enforce at most one owner per organization at the database level. A
// partial unique index keyed on (organizationId, role) but only over
// `role: 'owner'` rows means MongoDB rejects a second owner insert with
// E11000 — eliminating the race where two concurrent ownership-transfer
// requests both succeed before the application-level check runs. Admins
// and members are unaffected (the partial filter excludes them).
userOrganizationSchema.index(
  { organizationId: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: 'owner' } },
);

// SCIM lookups: `externalId eq` correlation and the member list of one
// directory group. Sparse — only SCIM-touched memberships carry the sub-document.
userOrganizationSchema.index({ 'organizationId': 1, 'scim.externalId': 1 }, { sparse: true });
userOrganizationSchema.index({ 'organizationId': 1, 'scim.groups': 1 }, { sparse: true });

export default model<UserOrganizationData>('UserOrganization', userOrganizationSchema);
