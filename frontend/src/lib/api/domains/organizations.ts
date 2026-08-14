// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import type { ApiResponse, Organization, OrganizationMember, MemberTeam, OrganizationRole, OrgAIConfig, Invitation, OrgIdpConfigDto, OrgIdpConfigCreate } from '@/types';

/** An org row from the sysadmin list, extended with soft-delete state. The list
 *  endpoint returns soft-deleted orgs inline (NOT filtered out), flagged with
 *  `pendingDeletion` + `deletedAt` so a sysadmin can see and restore them within
 *  the retention window. Absent on rows from other endpoints. */
export interface OrganizationListItem extends Organization {
  pendingDeletion?: boolean;
  deletedAt?: string;
}

export function organizationsApi(core: ApiCore) {
  return {
    // ============================================
    // Organization endpoints
    // ============================================
    listOrganizations: async (params?: { search?: string; tier?: 'developer' | 'pro' | 'team' | 'enterprise'; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ organizations: OrganizationListItem[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/organizations${buildQuery(params)}`);
    },

    deleteOrganization: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${id}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** POST /organization/:id/restore — restore a soft-deleted org within its
     *  retention window (reverses the soft-delete). Step-up gated exactly like
     *  DELETE, so the caller forwards a `stepUpToken`. Sysadmin or an admin/owner
     *  of the org / a managing parent (controller `canAdministerOrg`). 404 if the
     *  org was already purged or was never deleted. */
    restoreOrganization: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ organization: Organization }>>(`/api/organization/${id}/restore`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/export — GDPR portability dump. Unlike the other
     *  endpoints this streams a RAW JSON body (application/json + a
     *  Content-Disposition attachment header), NOT the usual `ApiResponse`
     *  envelope, so it bypasses `core.request` and returns the body text for the
     *  caller to save as a file. Sysadmin or an org admin/owner (org:settings +
     *  `canAdministerOrg`). */
    exportOrganization: async (id: string): Promise<string> => {
      await core.ensureFreshToken();
      const res = await fetch(`${API_URL}/api/organization/${id}/export`, {
        headers: core.authHeaders() as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`Failed to export organization: ${res.status} ${res.statusText}`);
      return res.text();
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

    /** GET /organization — the current user's own organization (any member).
     *  Wrapped in `{ organization }` by the backend (`getMyOrganization`). */
    getMyOrganization: async () => {
      return core.request<ApiResponse<{ organization: Organization }>>('/api/organization');
    },

    /** PATCH /organization/:id/identity — self-serve name/slug edit for an org
     *  the caller administers (owner/admin, `org:settings`). Distinct from the
     *  sysadmin-only PUT /organization/:id. Provide at least one of name/slug. */
    updateOrganizationIdentity: async (id: string, data: { name?: string; slug?: string }) => {
      return core.request<ApiResponse<{ organization: { id: string; name: string; slug: string; description: string } }>>(
        `/api/organization/${id}/identity`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        },
      );
    },

    /** Org → team subtree: returns `[self, ...descendantOrgIds]` for an org the
     * caller can access (own org, an ancestor admin, or sysadmin). */
    getOrganizationDescendants: async (id: string) => {
      return core.request<ApiResponse<{ orgIds: string[] }>>(`/api/organization/${id}/descendants`);
    },

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
        role?: 'owner' | 'admin' | 'member';
        status?: 'active' | 'inactive';
        sortBy?: string;
        sortOrder?: 'asc' | 'desc';
      },
    ) => {
      return core.request<ApiResponse<{
        members: OrganizationMember[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/organization/${orgId}/members${buildQuery(params)}`);
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

    /** PUT /organization/:id/seat-limit — set the account (root) seat limit.
     *  Body is `{ seats }` (integer >= -1; -1 = unlimited); applied to the
     *  resolved ROOT org. NO step-up. Gated to a service principal or a SYSTEM
     *  ADMIN (not a plain org-admin) — this is normally billing's entitlement
     *  sync, exposed here for sysadmin override. Returns the resolved root id. */
    setOrganizationSeatLimit: async (id: string, seats: number) => {
      return core.request<ApiResponse<{ rootOrgId: string }>>(`/api/organization/${id}/seat-limit`, {
        method: 'PUT',
        body: JSON.stringify({ seats }),
      });
    },

    /** GET /organization/:id/feature-entitlements — the account's (root) pooled
     *  feature entitlements (e.g. `sso`, `audit_log`) as a flag list. Service
     *  principal or an admin reading their OWN account. Feature FLAGS, not
     *  secrets. Fail-soft: an org with none yields an empty array. */
    getOrganizationFeatureEntitlements: async (id: string) => {
      return core.request<ApiResponse<{ featureEntitlements: string[] }>>(`/api/organization/${id}/feature-entitlements`);
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

    /** Transfer org ownership to another member. Backend body is `{ newOwnerId }`
     *  (PATCH /organization/:id/transfer-owner). Step-up gated (`requireStepUp`) —
     *  the caller obtains a token via `stepUpVerify` and forwards it here, exactly
     *  like `deleteOrganization`. Only the current owner or a system admin may call. */
    transferOrgOwnership: async (orgId: string, newOwnerUserId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${orgId}/transfer-owner`, {
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

    /** List the org's permission roles, each with its current members. */
    getOrganizationRoles: async (orgId: string) => {
      return core.request<ApiResponse<{ roles: OrganizationRole[] }>>(`/api/organization/${orgId}/roles`);
    },

    /** Create a custom permission role (name + optional description + permissions). */
    createRole: async (orgId: string, data: { name: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ role: OrganizationRole }>>(`/api/organization/${orgId}/roles`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Update a custom role's name/description/permissions (built-in roles are immutable). */
    updateRole: async (orgId: string, roleId: string, data: { name?: string; description?: string; permissions?: string[] }) => {
      return core.request<ApiResponse<{ role: OrganizationRole }>>(`/api/organization/${orgId}/roles/${roleId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** Delete a custom role (built-in roles can't be deleted). */
    deleteRole: async (orgId: string, roleId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/roles/${roleId}`, {
        method: 'DELETE',
      });
    },

    /** Add an existing org member (by id or email) to a role. */
    addRoleMember: async (orgId: string, roleId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<{ userId: string }>>(`/api/organization/${orgId}/roles/${roleId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Remove a user from a role. Recomputes their role; leaving Superadmins
     *  (system org) also clears their platform-admin flag. */
    removeRoleMember: async (orgId: string, roleId: string, userId: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/organization/${orgId}/roles/${roleId}/members/${userId}`, {
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
    listInvitations: async (params?: { status?: string; invitationType?: string; role?: 'admin' | 'member'; search?: string; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ invitations: Invitation[]; pagination?: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/invitation${buildQuery(params)}`);
    },

    /** Public preview of an invitation by its token (GET /invitation/:token).
     *  No auth required — powers the accept page before the user signs in. The
     *  `organization` field is the inviting org's id. */
    getInvitationByToken: async (token: string) => {
      return core.request<ApiResponse<{ invitation: {
        email: string;
        role: 'owner' | 'admin' | 'member';
        status: 'pending' | 'accepted' | 'expired' | 'revoked';
        expiresAt: string;
        organization: string;
        invitedBy: string;
        isValid: boolean;
        invitationType?: string;
        allowedOAuthProviders?: string[];
        canAcceptViaEmail: boolean;
        canAcceptViaGoogle: boolean;
      } }>>(`/api/invitation/${encodeURIComponent(token)}`);
    },

    /** Accept an invitation as the currently logged-in user (POST /invitation/accept).
     *  Body is just `{ token }`; the backend matches the invite email against the
     *  authenticated user. An OAuth provider (when the invite came in via OAuth)
     *  is forwarded via the `X-OAuth-Provider` header, mirroring the controller. */
    acceptInvitation: async (token: string, oauthProvider?: string) => {
      return core.request<ApiResponse<undefined>>('/api/invitation/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
        headers: oauthProvider ? { 'X-OAuth-Provider': oauthProvider } : undefined,
      });
    },

    /** First-time OAuth-based accept (POST /invitation/accept-oauth, public). Creates
     *  the user if needed. Requires the OAuth authorization `code` + `state` obtained
     *  from the provider redirect (the identity is verified server-side) — NOT a
     *  client-supplied profile. Reachable only after completing the OAuth dance. */
    acceptInvitationOAuth: async (data: { token: string; oauthProvider: 'google'; code: string; state: string }) => {
      return core.request<ApiResponse<undefined>>('/api/invitation/accept-oauth', {
        method: 'POST',
        body: JSON.stringify(data),
      });
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

    // ============================================
    // IdP / SSO roster (sysadmin only)
    // ============================================

    /** GET /admin/org-idp — every org's IdP config in one shot (sysadmin only).
     *  Powers the IdP roster page. Per-org CRUD lives on the org-detail page's
     *  IdP editor; this is the read-only fleet view of who has SSO configured. */
    listOrgIdpConfigs: async () => {
      return core.request<ApiResponse<{ configs: OrgIdpConfigDto[] }>>('/api/admin/org-idp');
    },

    // ============================================
    // Own-org IdP / SSO self-service (org owner/admin)
    // ============================================

    /** GET /organization/:id/idp — the caller's own org IdP config. Gated on the
     *  `org:settings` permission and own-org only; `sso` entitlement enforced
     *  server-side. `config` is null when no IdP is configured (a normal 200). */
    getOwnOrgIdpConfig: async (orgId: string) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto | null }>>(`/api/organization/${orgId}/idp`);
    },

    /** PUT /organization/:id/idp — upsert the caller's own org IdP config. On
     *  update, omitting `clientSecret` keeps the existing secret (write-only). */
    putOwnOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto }>>(`/api/organization/${orgId}/idp`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },
  };
}
