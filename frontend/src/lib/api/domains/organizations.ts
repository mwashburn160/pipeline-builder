// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Organization, OrganizationMember, MemberTeam, OrganizationGroup, OrgAIConfig, Invitation } from '@/types';

export function organizationsApi(core: ApiCore) {
  return {
    // ============================================
    // Organization endpoints
    // ============================================
    listOrganizations: async (params?: { search?: string; tier?: 'developer' | 'pro' | 'team' | 'enterprise'; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ organizations: Organization[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/organizations${buildQuery(params)}`);
    },

    deleteOrganization: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${id}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Change an org's pricing tier (sysadmin only). Reseeds quota limits
     *  on the org doc; the quota microservice is NOT updated by this call.
     *  Backend requires step-up because the change affects billing. */
    updateOrganizationTier: async (
      id: string,
      tier: 'developer' | 'pro' | 'team' | 'enterprise',
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ id: string; previousTier?: string; tier: string }>>(
        `/api/organization/${id}/tier`,
        {
          method: 'PATCH',
          body: JSON.stringify({ tier }),
          headers: core.stepUpHeader(stepUpToken),
        },
      );
    },

    /** Get a single org by id. Used by the sysadmin org-detail page.
     *  The backend (`getOrganizationById`) returns the org object flat as the
     *  response `data`, not wrapped in `{ organization }`. */
    getOrganization: async (id: string) => {
      return core.request<ApiResponse<Organization>>(`/api/organization/${id}`);
    },

    /** Org → team subtree: returns `[self, ...descendantOrgIds]` for an org the
     * caller can access (own org, an ancestor admin, or sysadmin). */
    getOrganizationDescendants: async (id: string) => {
      return core.request<ApiResponse<{ orgIds: string[] }>>(`/api/organization/${id}/descendants`);
    },

    getOrganizationMembers: async (orgId: string) => {
      return core.request<ApiResponse<{ members: OrganizationMember[] }>>(`/api/organization/${orgId}/members`);
    },

    addMemberToOrganization: async (orgId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<OrganizationMember>>(`/api/organization/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Descendant team roster for `orgId` (no member context) — for the
     *  "also add to teams" picker when adding a member. */
    getOrganizationTeams: async (orgId: string) => {
      return core.request<ApiResponse<{ teams: Array<{ orgId: string; orgName: string; parentOrgId?: string }> }>>(`/api/organization/${orgId}/teams`);
    },

    /** Pooled seat usage for the account (root): distinct active members + pending
     *  invites across the whole subtree vs the root's seat limit. Account admin or
     *  service principal only. `limit === -1` means unlimited seats. */
    getOrganizationSeatUsage: async (orgId: string) => {
      return core.request<ApiResponse<{ limit: number; used: number }>>(`/api/organization/${orgId}/seat-usage`);
    },

    /** Descendant teams of `orgId` annotated with whether `memberId` belongs to
     *  each — powers the admin "manage teams" view (a member can be on many teams). */
    getMemberTeams: async (orgId: string, memberId: string) => {
      return core.request<ApiResponse<{ teams: MemberTeam[] }>>(`/api/organization/${orgId}/member/${memberId}/teams`);
    },

    /** Add one user (by id or email) to several teams in `orgId`'s subtree at once. */
    bulkAddMemberToTeams: async (orgId: string, data: { userId?: string; email?: string; orgIds: string[]; role?: 'owner' | 'admin' | 'member' }) => {
      return core.request<ApiResponse<{ results: Array<{ orgId: string; status: 'added' | 'already_member' }> }>>(`/api/organization/${orgId}/members/bulk-add`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    removeMemberFromOrganization: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/members/${userId}`, {
        method: 'DELETE',
      });
    },

    updateMemberRole: async (orgId: string, userId: string, role: 'owner' | 'admin' | 'member') => {
      return core.request<ApiResponse<OrganizationMember>>(`/api/organization/${orgId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
    },

    // ============================================
    // Permission groups (first-class RBAC). Group membership drives the cached
    // org role: Administrators → org-admin, Superadmins (system org only) →
    // platform admin.
    // ============================================

    /** List the org's permission groups, each with its current members. */
    getOrganizationGroups: async (orgId: string) => {
      return core.request<ApiResponse<{ groups: OrganizationGroup[] }>>(`/api/organization/${orgId}/groups`);
    },

    /** Create a custom permission group (name + optional description + permissions). */
    createGroup: async (orgId: string, data: { name: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ group: OrganizationGroup }>>(`/api/organization/${orgId}/groups`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a custom group's name/description/permissions (built-in groups are immutable). */
    updateGroup: async (orgId: string, groupId: string, data: { name?: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ group: OrganizationGroup }>>(`/api/organization/${orgId}/groups/${groupId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Delete a custom group (built-in groups can't be deleted). */
    deleteGroup: async (orgId: string, groupId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/groups/${groupId}`, {
        method: 'DELETE',
      });
    },

    /** Add an existing org member (by id or email) to a group. */
    addGroupMember: async (orgId: string, groupId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<{ userId: string }>>(`/api/organization/${orgId}/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Remove a user from a group. Recomputes their role; leaving Superadmins
     *  (system org) also clears their platform-admin flag. */
    removeGroupMember: async (orgId: string, groupId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/groups/${groupId}/members/${userId}`, {
        method: 'DELETE',
      });
    },

    /** Deactivate a member (soft removal — keeps record, revokes access). */
    deactivateMember: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/members/${userId}/deactivate`, {
        method: 'PATCH',
      });
    },

    /** Reactivate a previously deactivated member. */
    activateMember: async (orgId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/members/${userId}/activate`, {
        method: 'PATCH',
      });
    },

    getOrgAIConfig: async () => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config');
    },

    updateOrgAIConfig: async (data: Record<string, string | null>) => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    // ============================================
    // Invitation endpoints
    // ============================================
    listInvitations: async (params?: { status?: string; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ invitations: Invitation[]; pagination?: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/invitation${buildQuery(params)}`);
    },

    sendInvitation: async (data: { email: string; role?: 'admin' | 'member'; invitationType?: string }) => {
      return core.request<ApiResponse<{ invitation: Invitation }>>('/api/invitation/send', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    revokeInvitation: async (invitationId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/invitation/${invitationId}`, {
        method: 'DELETE',
      });
    },

    resendInvitation: async (invitationId: string) => {
      return core.request<ApiResponse<{ invitation: Invitation }>>(`/api/invitation/${invitationId}/resend`, {
        method: 'POST',
      });
    },
  };
}
