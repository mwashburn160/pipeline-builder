// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Rendering platform records as SCIM User and Group resources (RFC 7643). */

import type { Types } from 'mongoose';
import type { ScimGroupResource, ScimUserResource } from './scim-filter.js';
import { SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA } from '../constants/scim.js';
import IdpGroupMapping from '../models/idp-group-mapping.js';
import type { UserOrganizationData } from '../models/user-organization.js';

// ---------------------------------------------------------------------------
// Resource rendering
// ---------------------------------------------------------------------------

/** Public base URL of the SCIM endpoint, used for `meta.location`. Resolved
 *  from configuration (never from the request) so a spoofed Host header can't
 *  point an IdP's follow-up calls somewhere else. */
export async function scimBaseUrl(): Promise<string> {
  const { config } = await import('../config/index.js');
  return `${config.app.frontendUrl.replace(/\/+$/, '')}/api/scim/v2`;
}

/** Enough of a membership row to render. `joinedAt` carries a schema default and
 *  `updatedAt` comes from `timestamps: true`, so both are always present — they
 *  are required here rather than defaulted at the read site. */
export type MembershipLike = Pick<UserOrganizationData, 'isActive' | 'role' | 'joinedAt' | 'scim'> & {
  userId: Types.ObjectId | string;
  updatedAt: Date;
};

export type UserLike = { _id: unknown; email: string; username: string; createdAt?: Date };

export function userResource(
  user: UserLike,
  membership: MembershipLike,
  groupsByKey: Map<string, { id: string; display: string }>,
  baseUrl: string,
): ScimUserResource {
  const s = membership.scim ?? {};
  const id = String(user._id);
  const given = s.givenName ?? undefined;
  const family = s.familyName ?? undefined;
  const formatted = [given, family].filter(Boolean).join(' ') || undefined;
  return {
    schemas: [SCIM_USER_SCHEMA],
    ...(s.externalId ? { externalId: s.externalId } : {}),
    id,
    userName: s.userName || user.email,
    ...(given || family ? { name: { ...(given ? { givenName: given } : {}), ...(family ? { familyName: family } : {}), ...(formatted ? { formatted } : {}) } } : {}),
    ...(s.displayName ? { displayName: s.displayName } : {}),
    emails: [{ value: user.email, type: 'work', primary: true }],
    active: membership.isActive,
    // Read-only per RFC 7643 §4.1.2: group membership is changed through the
    // Groups endpoint, never by writing this back on a User.
    groups: (s.groups ?? [])
      .map((key) => groupsByKey.get(key))
      .filter((g): g is { id: string; display: string } => !!g)
      .map((g) => ({ value: g.id, display: g.display, type: 'direct' as const })),
    meta: {
      resourceType: 'User',
      // `joinedAt` (schema default Date.now) and the `timestamps: true` pair are
      // written on every membership, so both reads are unconditional.
      created: new Date(membership.joinedAt).toISOString(),
      lastModified: new Date(membership.updatedAt).toISOString(),
      location: `${baseUrl}/Users/${id}`,
    },
  };
}

/** Enough of a mapping row to render — satisfied by both a document and a lean
 *  object. The timestamps are REQUIRED: `IdpGroupMapping` declares
 *  `timestamps: true` and both queries that feed {@link groupResource}
 *  (`listGroups`' `find(...).lean()` and `requireGroup`'s `findOne`) apply no
 *  projection, so every rendered row carries them. */
export type GroupLike = {
  _id: unknown;
  group: string;
  scimExternalId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function groupResource(
  doc: GroupLike,
  members: Array<{ value: string; display: string }>,
  baseUrl: string,
): ScimGroupResource {
  const id = String(doc._id);
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    ...(doc.scimExternalId ? { externalId: doc.scimExternalId } : {}),
    id,
    displayName: doc.group,
    members: members.map((m) => ({ ...m, type: 'User' as const })),
    meta: {
      resourceType: 'Group',
      created: new Date(doc.createdAt).toISOString(),
      lastModified: new Date(doc.updatedAt).toISOString(),
      location: `${baseUrl}/Groups/${id}`,
    },
  };
}

/** Every group mapping of the org, keyed by `groupKey` (for rendering a user's
 *  `groups` without a query per member). */
export async function groupIndex(orgId: string): Promise<Map<string, { id: string; display: string }>> {
  const docs = await IdpGroupMapping.find({ organizationId: orgId }).select('group groupKey').lean();
  return new Map(docs.map((d) => [d.groupKey, { id: String(d._id), display: d.group }]));
}
