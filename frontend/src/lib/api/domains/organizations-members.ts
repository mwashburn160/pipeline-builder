// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, OrganizationMember, MemberTeam, OrganizationRole } from '@/types';
import type { OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';

/**
 * Org membership: the member roster, adding / removing / (de)activating a
 * member, team placement, ownership transfer, and the first-class permission
 * roles and their members.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationMembersApi(core: ApiCore) {
  return {
    /** A bounded, filterable page of an org's members. `search` matches
     *  username/email, `role` narrows the coarse role, and `status`
     *  (active|inactive) narrows the membership active flag — all applied
     *  server-side. `sortBy`/`sortOrder` drive server-side ordering (the backend
     *  whitelists sortable fields). Each member carries its assigned Role names,
     *  so the UI needs no all-roles O(members×roles) scan to render chips. */
    getOrganizationMembers: async (
      orgId: string,
      params?: {
        limit?: number;
        offset?: number;
        search?: string;
        role?: OrgRole;
        status?: 'active' | 'inactive';
        sortBy?: string;
        sortOrder?: 'asc' | 'desc';
      },
      /** `signal` cancels the request on the wire (shared query cache / debounced search). */
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{
        members: OrganizationMember[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/organization/${encodeURIComponent(orgId)}/members${buildQuery(params)}`, { signal: opts?.signal });
    },

    addMemberToOrganization: async (orgId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${encodeURIComponent(orgId)}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },


    /** Descendant teams of `orgId` annotated with whether `memberId` belongs to
     *  each — powers the admin "manage teams" view (a member can be on many teams). */
    getMemberTeams: async (orgId: string, memberId: string) => {
      return core.request<ApiResponse<{ teams: MemberTeam[] }>>(`/api/organization/${encodeURIComponent(orgId)}/member/${encodeURIComponent(memberId)}/teams`);
    },

    /** Add one user (by id or email) to several teams in `orgId`'s subtree at once. */
    bulkAddMemberToTeams: async (orgId: string, data: { userId?: string; email?: string; orgIds: string[]; role?: OrgRole }) => {
      return core.request<ApiResponse<{ results: Array<{ orgId: string; status: 'added' | 'already_member' }> }>>(`/api/organization/${encodeURIComponent(orgId)}/members/bulk-add`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    removeMemberFromOrganization: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
    },

    /** Transfer org ownership to another member. Backend body is `{ newOwnerId }`
     *  (PATCH /organization/:id/transfer-owner). Step-up gated (`requireStepUp`) —
     *  the caller obtains a token via `stepUpVerify` and forwards it here, exactly
     *  like `deleteOrganization`. Only the current owner or a system admin may call. */
    transferOrgOwnership: async (orgId: string, newOwnerUserId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${encodeURIComponent(orgId)}/transfer-owner`, {
        method: 'PATCH',
        body: JSON.stringify({ newOwnerId: newOwnerUserId }),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // ============================================
    // Permission roles (first-class RBAC). Role membership drives the cached
    // org role: Administrators → org-admin, Superadmins (system org only) →
    // platform admin.
    // ============================================

    /** List the org's permission roles, each with its current members. Without
     *  `params.limit` every role is returned (what the pickers need); with it the
     *  roles are paged server-side. `pagination.total` always counts every role. */
    getOrganizationRoles: async (
      orgId: string,
      params?: { limit?: number; offset?: number },
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{
        roles: OrganizationRole[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/organization/${encodeURIComponent(orgId)}/roles${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** Create a custom permission role (name + optional description + permissions). */
    createRole: async (orgId: string, data: { name: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ role: OrganizationRole }>>(`/api/organization/${encodeURIComponent(orgId)}/roles`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a custom role's name/description/permissions (built-in roles are immutable). */
    updateRole: async (orgId: string, roleId: string, data: { name?: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ role: OrganizationRole }>>(`/api/organization/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Delete a custom role (built-in roles can't be deleted). */
    deleteRole: async (orgId: string, roleId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}`, {
        method: 'DELETE',
      });
    },

    /** Add an existing org member (by id or email) to a role. */
    addRoleMember: async (orgId: string, roleId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<{ userId: string }>>(`/api/organization/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Remove a user from a role. Recomputes their role; leaving Superadmins
     *  (system org) also clears their platform-admin flag. */
    removeRoleMember: async (orgId: string, roleId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${encodeURIComponent(orgId)}/roles/${encodeURIComponent(roleId)}/members/${encodeURIComponent(userId)}`, {
        method: 'DELETE',
      });
    },

    /** Deactivate a member (soft removal — keeps record, revokes access). */
    deactivateMember: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/deactivate`, {
        method: 'PATCH',
      });
    },

    /** Reactivate a previously deactivated member. */
    activateMember: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/activate`, {
        method: 'PATCH',
      });
    },
  };
}
