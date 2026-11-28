// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';

/**
 * The org hierarchy and account pool: an org's teams (live and soft-deleted),
 * deleting a team, and the account-wide seat usage, seat limit and feature
 * entitlements.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationHierarchyApi(core: ApiCore) {
  return {
    /** Descendant team roster for `orgId` (no member context) — for the
     *  "also add to teams" picker when adding a member. */
    getOrganizationTeams: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ teams: Array<{ orgId: string; orgName: string; parentOrgId?: string }> }>>(`/api/organization/${encodeURIComponent(orgId)}/teams`, { signal: opts?.signal });
    },

    /** GET /organization/:id/teams/deleted — the org's soft-deleted teams still
     *  inside their retention window (`org_settings:write`). Live listings exclude them. */
    listDeletedTeams: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ teams: DeletedTeam[] }>>(`/api/organization/${encodeURIComponent(orgId)}/teams/deleted`, { signal: opts?.signal });
    },

    /** DELETE /organization/:id/teams/:teamId — a parent admin soft-deletes one
     *  of its teams (`org_settings:write` + step-up). Restorable with
     *  {@link restoreOrganization} on the team id until its purge date. */
    deleteTeam: async (orgId: string, teamId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${encodeURIComponent(orgId)}/teams/${encodeURIComponent(teamId)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Pooled seat usage for the account (root): distinct active members + pending
     *  invites across the whole subtree vs the root's seat limit. Account admin or
     *  service principal only. `limit === -1` means unlimited seats. */
    getOrganizationSeatUsage: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ limit: number; used: number; tier?: string }>>(`/api/organization/${encodeURIComponent(orgId)}/seat-usage`, { signal: opts?.signal });
    },

    /** PUT /organization/:id/seat-limit — set the account (root) seat limit.
     *  Body is `{ seats }` (integer >= -1; -1 = unlimited); applied to the
     *  resolved ROOT org. NO step-up. Gated to a service principal or a SYSTEM
     *  ADMIN (not a plain org-admin) — this is normally billing's entitlement
     *  sync, exposed here for sysadmin override. Returns the resolved root id. */
    setOrganizationSeatLimit: async (id: string, seats: number) => {
      return core.request<ApiResponse<{ rootOrgId: string }>>(`/api/organization/${encodeURIComponent(id)}/seat-limit`, {
        method: 'PUT',
        body: JSON.stringify({ seats }),
      });
    },

    /** GET /organization/:id/feature-entitlements — the account's (root) pooled
     *  feature entitlements (e.g. `sso`, `advanced_reporting`) as a flag list. Service
     *  principal or an admin reading their OWN account. Feature FLAGS, not
     *  secrets. Fail-soft: an org with none yields an empty array. */
    getOrganizationFeatureEntitlements: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ featureEntitlements: string[] }>>(`/api/organization/${encodeURIComponent(id)}/feature-entitlements`, { signal: opts?.signal });
    },
  };
}

/** A team as named in a hierarchy listing. */
export interface OrgTeamRef {
  orgId: string;
  orgName: string;
}

/** A soft-deleted team still inside its retention window (restorable until `purgeAfter`). */
export interface DeletedTeam extends OrgTeamRef {
  deletedAt: string;
  purgeAfter: string;
  /** Soft-deleted by a platform operator (a takedown), not by the account. */
  deletedByPlatform: boolean;
  /** Whether THIS viewer may restore it: false for a platform takedown seen by a tenant. */
  restorable: boolean;
}
