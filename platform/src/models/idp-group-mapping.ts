// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org IdP GROUP → Role mapping.
 *
 * One row per group the org's identity provider may assert. At SSO sign-in the
 * groups claim is read off the validated `id_token` (claim name configurable per
 * IdP — see `OrgIdpConfig.groupsClaim`), matched against these rows, and the
 * union of their `roleIds` is the Role set the user is granted in THAT org (see
 * `services/sso-jit-service.ts`).
 *
 * Deliberately a SEPARATE collection rather than an array on `OrgIdpConfig`:
 * SCIM provisions Groups through the same mapping, and its per-group writes
 * would otherwise contend on one config document. Every field is scoped by
 * `organizationId`, so a mapping can only ever name Roles of — and grant membership in —
 * the org that owns it.
 *
 * `group` keeps the admin's spelling for display; `groupKey` is the lowercased
 * match key, because IdPs are inconsistent about the case of group values
 * (`Engineering` vs `engineering`) and an org must not be able to register both
 * and get two different Role sets depending on which one the IdP sent.
 */

import { Schema, model, Types, type HydratedDocument } from 'mongoose';

export interface IdpGroupMappingData {
  /** Org whose IdP asserts this group. Matches `OrgIdpConfig.organizationId`. */
  organizationId: Types.ObjectId;
  /** The group value as the admin entered it — display only. */
  group: string;
  /** Lowercased, trimmed `group`; the value matching is done on. Unique per org. */
  groupKey: string;
  /** Roles granted to a member of this group, all owned by `organizationId`. */
  roleIds: Types.ObjectId[];
  /**
   * The directory's own id for the group, as SCIM's `externalId`. Set when
   * the row was pushed by (or later matched to) a SCIM client; absent for a rule
   * an admin typed in the editor. It is the IdP's correlation handle ONLY — the
   * platform never resolves a group by it for anything but an `externalId eq`
   * filter, and it grants nothing on its own.
   */
  scimExternalId?: string | null;
  /** True when a SCIM client created this row. Display only: an admin may edit
   *  the Roles of a SCIM-created group exactly as they would any other. */
  scimManaged?: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type IdpGroupMappingDocument = HydratedDocument<IdpGroupMappingData>;

const idpGroupMappingSchema = new Schema<IdpGroupMappingData>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, index: true },
    group: { type: String, required: true },
    groupKey: { type: String, required: true },
    roleIds: { type: [Schema.Types.ObjectId], ref: 'Role', default: [] },
    scimExternalId: { type: String, default: null, maxlength: 256 },
    scimManaged: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
  },
  { timestamps: true, collection: 'idp_group_mappings' },
);

// One mapping per group per org — a second row for the same group would make the
// resolved Role set depend on document order.
idpGroupMappingSchema.index({ organizationId: 1, groupKey: 1 }, { unique: true });

// SCIM `GET /Groups?filter=externalId eq "…"` — the lookup an IdP does before it
// decides whether to create a group. Sparse: only SCIM-pushed rows carry one.
idpGroupMappingSchema.index({ organizationId: 1, scimExternalId: 1 }, { sparse: true });

export default model<IdpGroupMappingData>('IdpGroupMapping', idpGroupMappingSchema);
