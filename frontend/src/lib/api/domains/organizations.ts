// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AccessKeyMeta } from './auth';
import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import type { ApiResponse, Organization, OrganizationMember, MemberTeam, OrganizationRole, OrgAIConfig, Invitation, OrgIdpConfigDto, OrgIdpConfigCreate, IdpGroupMappingDto, OrgMfaPolicy, OrgPasswordPolicy, OrgAuthenticatorPolicy, MfaResetRequest, ParsedIdpMetadata, QuotaTier, SsoSpInfo, SsoTestReport } from '@/types';

/**
 * An org SERVICE ACCOUNT: a non-human principal owned by the org. It holds the
 * org's roles, signs in with nothing (only `pb_sa_…` keys), consumes NO seat,
 * and has its own per-period token-exchange budget.
 */
export interface ServiceAccount {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  roles: Array<{ id: string; name: string; permissions: string[] }>;
  /** Effective permissions — the union of its roles'. */
  permissions: string[];
  /** Token exchanges allowed per period; -1 = unlimited. */
  tokenBudget: number;
  usage: { exchanges: number; resetAt: string };
  disabled: boolean;
  createdBy: string | null;
  createdByEmail: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  keys: AccessKeyMeta[];
  /** Always 0 — service accounts take no seat. */
  seatsConsumed: 0;
}

/** Org-level service-account facts the settings page states explicitly. */
export interface ServiceAccountBilling {
  accounts: number;
  maxAccounts: number;
  /** Always 0 — service accounts never consume seats. */
  seatsConsumed: 0;
  /** Length of the token-exchange budget period, in days. */
  budgetPeriodDays: number;
}

/** One member of the roster embedded in `GET /organization/:id`. */
export interface OrganizationRosterMember {
  _id: string;
  username?: string;
  email?: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt?: string;
}

/** `GET /organization/:id` — the org plus one page of its member roster. */
export interface OrganizationDetail extends Organization {
  members: OrganizationRosterMember[];
  isTeam?: boolean;
  rootOrgId?: string;
  pendingDeletion?: boolean;
  deletedAt?: string;
  purgeAfter?: string;
  /** Sysadmin read only: the org's live teams (empty for a team or a flat root). */
  teams?: OrgTeamRef[];
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
}

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
    /** `opts.signal` cancels the request on the wire (shared query cache / debounced pickers). */
    listOrganizations: async (params?: { search?: string; tier?: QuotaTier; offset?: number; limit?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ organizations: OrganizationListItem[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/organizations${buildQuery(params)}`, { signal: opts?.signal });
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
      tier: QuotaTier,
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

    /** POST /organization/:id/move — sysadmin reparenting (step-up). `parentOrgId`
     *  names an eligible root (team/enterprise tier) to nest under, or `null` to
     *  make the org top-level. The backend refuses (400) moves that would break
     *  the one-level hierarchy, e.g. nesting a root that still has teams. */
    moveOrganization: async (id: string, parentOrgId: string | null, stepUpToken?: string) => {
      return core.request<ApiResponse<{ organization: Organization }>>(`/api/organization/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ parentOrgId }),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Get a single org by id. Used by the sysadmin org-detail page.
     *  The backend (`getOrganizationById`) returns the org object flat as the
     *  response `data`, not wrapped in `{ organization }`, and embeds one page of
     *  the member roster: `membersLimit` (1-500, default 100) / `membersOffset`
     *  page it, while `memberCount` is always the full total. */
    getOrganization: async (
      id: string,
      params?: { membersLimit?: number; membersOffset?: number },
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<OrganizationDetail>>(`/api/organization/${id}${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** PUT /organization/:id — sysadmin edit of an org's name, slug and/or
     *  description (the only route that edits the description). Step-up gated:
     *  the caller confirms in a `StepUpModal` and forwards its token. */
    updateOrganization: async (id: string, data: { name?: string; slug?: string; description?: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ organization: { id: string; name: string; slug: string; description: string } }>>(
        `/api/organization/${id}`,
        { method: 'PUT', body: JSON.stringify(data), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** GET /organization — the current user's own organization (any member).
     *  Wrapped in `{ organization }` by the backend (`getMyOrganization`). */
    getMyOrganization: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ organization: Organization }>>('/api/organization', { signal: opts?.signal });
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
      /** `signal` cancels the request on the wire (shared query cache / debounced search). */
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{
        members: OrganizationMember[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/organization/${orgId}/members${buildQuery(params)}`, { signal: opts?.signal });
    },

    addMemberToOrganization: async (orgId: string, data: { userId?: string; email?: string }) => {
      return core.request<ApiResponse<OrganizationMember>>(`/api/organization/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Descendant team roster for `orgId` (no member context) — for the
     *  "also add to teams" picker when adding a member. */
    getOrganizationTeams: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ teams: Array<{ orgId: string; orgName: string; parentOrgId?: string }> }>>(`/api/organization/${orgId}/teams`, { signal: opts?.signal });
    },

    /** GET /organization/:id/teams/deleted — the org's soft-deleted teams still
     *  inside their retention window (`org:settings`). Live listings exclude them. */
    listDeletedTeams: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ teams: DeletedTeam[] }>>(`/api/organization/${orgId}/teams/deleted`, { signal: opts?.signal });
    },

    /** DELETE /organization/:id/teams/:teamId — a parent admin soft-deletes one
     *  of its teams (`org:settings` + step-up). Restorable with
     *  {@link restoreOrganization} on the team id until its purge date. */
    deleteTeam: async (orgId: string, teamId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${orgId}/teams/${teamId}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Pooled seat usage for the account (root): distinct active members + pending
     *  invites across the whole subtree vs the root's seat limit. Account admin or
     *  service principal only. `limit === -1` means unlimited seats. */
    getOrganizationSeatUsage: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ limit: number; used: number }>>(`/api/organization/${orgId}/seat-usage`, { signal: opts?.signal });
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
     *  feature entitlements (e.g. `sso`, `advanced_reporting`) as a flag list. Service
     *  principal or an admin reading their OWN account. Feature FLAGS, not
     *  secrets. Fail-soft: an org with none yields an empty array. */
    getOrganizationFeatureEntitlements: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ featureEntitlements: string[] }>>(`/api/organization/${id}/feature-entitlements`, { signal: opts?.signal });
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
      }>>(`/api/organization/${orgId}/roles${buildQuery(params)}`, { signal: opts?.signal });
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

    // ============================================
    // Service accounts (#2): org-owned non-human principals. They hold the org's
    // roles, authenticate with `pb_sa_…` keys, take NO seat, and carry their own
    // token-exchange budget. Every write is step-up gated, like PAT creation.
    // ============================================

    /** List the org's service accounts (each with its roles + key metadata). */
    listServiceAccounts: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ serviceAccounts: ServiceAccount[]; billing: ServiceAccountBilling }>>(
        `/api/organization/${orgId}/service-accounts`,
        { signal: opts?.signal },
      );
    },

    /** GET /organization/:id/service-accounts/:accountId — one account with its
     *  roles, usage and key metadata (never a secret). */
    getServiceAccount: async (orgId: string, accountId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(
        `/api/organization/${orgId}/service-accounts/${accountId}`,
        { signal: opts?.signal },
      );
    },

    /** Create a service account. Its roles can't exceed the creator's own permissions. */
    createServiceAccount: async (
      orgId: string,
      data: { name: string; description?: string; roleIds?: string[]; tokenBudget?: number },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(`/api/organization/${orgId}/service-accounts`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
        body: JSON.stringify(data),
      });
    },

    /** Update an account. `roleIds` REPLACES the role set; `disabled` is the reversible off-switch. */
    updateServiceAccount: async (
      orgId: string,
      accountId: string,
      data: { description?: string | null; roleIds?: string[]; tokenBudget?: number; disabled?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ serviceAccount: ServiceAccount }>>(
        `/api/organization/${orgId}/service-accounts/${accountId}`,
        { method: 'PATCH', headers: core.stepUpHeader(stepUpToken), body: JSON.stringify(data) },
      );
    },

    /** Delete an account and every key it holds. */
    deleteServiceAccount: async (orgId: string, accountId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<undefined>>(`/api/organization/${orgId}/service-accounts/${accountId}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /**
     * Issue a key. The raw `pb_sa_…` key comes back ONCE and is never retrievable again.
     *
     * `scope` narrows the key to a single capability INSTEAD of the account's
     * roles — `scim` for an identity provider's provisioning client, and the
     * ingest/registry scopes for the machine surfaces that use them. A scoped key
     * carries no permissions at all, so it can do that one thing and nothing else.
     */
    createServiceAccountKey: async (
      orgId: string,
      accountId: string,
      data: { name: string; expiresIn?: number; ipAllowlist?: string[]; scope?: string },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ key: string; accessKey: AccessKeyMeta }>>(
        `/api/organization/${orgId}/service-accounts/${accountId}/keys`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken), body: JSON.stringify(data) },
      );
    },

    /** Revoke one key immediately — it stops working everywhere within 5 minutes. */
    revokeServiceAccountKey: async (orgId: string, accountId: string, keyId: string) => {
      return core.request<ApiResponse<{ revoked: boolean }>>(
        `/api/organization/${orgId}/service-accounts/${accountId}/keys/${keyId}`,
        { method: 'DELETE' },
      );
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

    getOrgAIConfig: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', { signal: opts?.signal });
    },

    /** Update org AI provider keys. Step-up-gated server-side (persists provider
     *  secrets), so the caller forwards a `stepUpToken` obtained via StepUpModal. */
    updateOrgAIConfig: async (data: Record<string, string | null>, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgAIConfig>>('/api/organization/ai-config', {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // ============================================
    // Invitation endpoints
    // ============================================
    listInvitations: async (params?: { status?: string; invitationType?: string; role?: 'admin' | 'member'; search?: string; offset?: number; limit?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ invitations: Invitation[]; pagination?: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/invitation${buildQuery(params)}`, { signal: opts?.signal });
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
    listOrgIdpConfigs: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ configs: OrgIdpConfigDto[] }>>('/api/admin/org-idp', { signal: opts?.signal });
    },

    // ============================================
    // Own-org IdP / SSO self-service (org owner/admin)
    // ============================================

    /** GET /organization/:id/idp — the caller's own org IdP config. Gated on the
     *  `org:settings` permission and own-org only; `sso` entitlement enforced
     *  server-side. `config` is null when no IdP is configured (a normal 200). */
    getOwnOrgIdpConfig: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto | null }>>(`/api/organization/${orgId}/idp`, { signal: opts?.signal });
    },

    /** PUT /organization/:id/idp — CREATE the caller's own org IdP config (the
     *  full body the protocol requires). Edits to an existing config go through
     *  {@link patchOwnOrgIdpConfig}. Every write needs an MFA-grade session and a
     *  strong-factor step-up: the editor confirms in a `StepUpModal`
     *  (`requireStrongFactor`) and forwards its token here. */
    putOwnOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>, stepUpToken?: string) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto }>>(`/api/organization/${orgId}/idp`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** PATCH /organization/:id/idp — change only the fields sent on an EXISTING
     *  config (404 when none exists). An omitted/empty `clientSecret` keeps the
     *  stored one. */
    patchOwnOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>, stepUpToken?: string) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto }>>(`/api/organization/${orgId}/idp`, {
        method: 'PATCH',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** DELETE /organization/:id/idp — disconnect the org's SSO entirely. Members
     *  fall back to their other sign-in methods; group → Role mappings stop firing. */
    deleteOwnOrgIdpConfig: async (orgId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<Record<string, never>>>(`/api/organization/${orgId}/idp`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/idp/sp-info — the values to register AT the IdP
     *  (SAML entity ID / ACS / metadata / SLO URLs, OIDC redirect URI, SP
     *  certificates), computed by the server from its public URL. */
    getOwnOrgIdpSpInfo: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ sp: SsoSpInfo }>>(`/api/organization/${orgId}/idp/sp-info`, { signal: opts?.signal });
    },

    /** POST /organization/:id/idp/metadata/import — parse an IdP metadata
     *  document (pasted/uploaded XML, or an https URL the server fetches under its
     *  SSRF guard) into SAML form fields. Saves nothing. */
    importIdpMetadata: async (orgId: string, source: { xml: string } | { url: string }) => {
      return core.request<ApiResponse<{ metadata: ParsedIdpMetadata }>>(`/api/organization/${orgId}/idp/metadata/import`, {
        method: 'POST', body: JSON.stringify(source),
      });
    },

    /** POST /organization/:id/idp/test — start a TEST CONNECTION (dry run):
     *  `{ url, state }`; open `url` in a popup. Works before SSO is enabled. */
    startSsoTest: async (orgId: string) => {
      return core.request<ApiResponse<{ url: string; state: string }>>(`/api/organization/${orgId}/idp/test`, { method: 'POST' });
    },

    /** POST /organization/:id/idp/test/complete — collect the dry-run report.
     *  OIDC passes the IdP's `code` (or `error`); SAML only the `state`. */
    completeSsoTest: async (orgId: string, params: { state: string; code?: string; error?: string }) => {
      return core.request<ApiResponse<{ report: SsoTestReport }>>(`/api/organization/${orgId}/idp/test/complete`, {
        method: 'POST', body: JSON.stringify(params),
      });
    },

    // -- IdP group → Role mappings (3a) --
    // What the IdP's groups are worth inside the org. Gated on `roles:manage`
    // (a mapping grants Roles), own-org only, `sso` entitlement server-side.

    /** GET /organization/:id/idp/group-mappings — this org's mapping rules,
     *  each hydrated with the Roles it grants. */
    listIdpGroupMappings: async (orgId: string) => {
      return core.request<ApiResponse<{ mappings: IdpGroupMappingDto[] }>>(`/api/organization/${orgId}/idp/group-mappings`);
    },

    /** POST /organization/:id/idp/group-mappings — map one group to a Role set. */
    createIdpGroupMapping: async (orgId: string, data: { group: string; roleIds: string[] }) => {
      return core.request<ApiResponse<{ mapping: IdpGroupMappingDto }>>(`/api/organization/${orgId}/idp/group-mappings`, {
        method: 'POST', body: JSON.stringify(data),
      });
    },

    /** PUT /organization/:id/idp/group-mappings/:mappingId — edit group/Roles. */
    updateIdpGroupMapping: async (orgId: string, mappingId: string, data: { group?: string; roleIds?: string[] }) => {
      return core.request<ApiResponse<{ mapping: IdpGroupMappingDto }>>(`/api/organization/${orgId}/idp/group-mappings/${mappingId}`, {
        method: 'PUT', body: JSON.stringify(data),
      });
    },

    /** DELETE /organization/:id/idp/group-mappings/:mappingId — drop a rule.
     *  Roles it granted fall away at each member's next sign-in. */
    deleteIdpGroupMapping: async (orgId: string, mappingId: string) => {
      return core.request<ApiResponse<Record<string, never>>>(`/api/organization/${orgId}/idp/group-mappings/${mappingId}`, {
        method: 'DELETE',
      });
    },

    // -- Domain-based join (P2b): admin domain management + join-request review --

    listOrgDomains: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ domains: OrgDomainDto[]; entitled: boolean }>>(`/api/organization/${orgId}/domains`, { signal: opts?.signal });
    },
    addOrgDomain: async (orgId: string, domain: string) => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${orgId}/domains`, {
        method: 'POST', body: JSON.stringify({ domain }),
      });
    },
    verifyOrgDomain: async (orgId: string, domainId: string) => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${orgId}/domains/${domainId}/verify`, { method: 'POST' });
    },
    setOrgDomainMode: async (orgId: string, domainId: string, autoJoin: 'off' | 'request' | 'auto') => {
      return core.request<ApiResponse<{ domain: OrgDomainDto }>>(`/api/organization/${orgId}/domains/${domainId}`, {
        method: 'PATCH', body: JSON.stringify({ autoJoin }),
      });
    },
    deleteOrgDomain: async (orgId: string, domainId: string) => {
      return core.request<ApiResponse<{ deleted: boolean }>>(`/api/organization/${orgId}/domains/${domainId}`, { method: 'DELETE' });
    },
    listOrgJoinRequests: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ requests: OrgJoinRequestDto[] }>>(`/api/organization/${orgId}/join-requests`, { signal: opts?.signal });
    },
    decideOrgJoinRequest: async (orgId: string, reqId: string, decision: 'approve' | 'deny') => {
      return core.request<ApiResponse<{ userId: string; status: 'approved' | 'denied' }>>(`/api/organization/${orgId}/join-requests/${reqId}/${decision}`, { method: 'POST' });
    },

    /** The org's impersonation policy: its OWN setting and the EFFECTIVE one. A
     *  team's policy can be tightened by its parent (strictest wins), so the UI
     *  must show both or an admin who set `open` can't tell why it isn't. */
    getImpersonationPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<EffectiveImpersonationPolicyDto>>(`/api/organization/${orgId}/impersonation-policy`, { signal: opts?.signal });
    },
    /** Change the policy. Step-up gated: loosening it widens who can see the org's data. */
    updateImpersonationPolicy: async (
      orgId: string,
      body: { impersonationPolicy?: ImpersonationPolicy; allowSelfApproval?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<EffectiveImpersonationPolicyDto>>(`/api/organization/${orgId}/impersonation-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** The org's two-factor requirement (#8): its OWN setting and what actually
     *  governs, since a parent org's requirement also applies to its teams. */
    getMfaPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgMfaPolicy>>(`/api/organization/${orgId}/mfa-policy`, { signal: opts?.signal });
    },

    /** GET /organization/:id/password-policy — the org's minimum password length
     *  (own and effective, with the platform floor and ceiling). */
    getPasswordPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgPasswordPolicy>>(`/api/organization/${orgId}/password-policy`, { signal: opts?.signal });
    },
    /** PATCH — `minLength: null` clears the org's own minimum. Step-up gated;
     *  LOWERING it also needs a session opened with a second factor. */
    updatePasswordPolicy: async (orgId: string, body: { minLength: number | null }, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgPasswordPolicy>>(`/api/organization/${orgId}/password-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/authenticator-policy — the passkey-model allowlist,
     *  the FIDO MDS catalog for naming models, and members' compliance. */
    getAuthenticatorPolicy: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<OrgAuthenticatorPolicy>>(`/api/organization/${orgId}/authenticator-policy`, { signal: opts?.signal });
    },
    /** PATCH — an empty list clears it (any model). Step-up gated; WIDENING or
     *  clearing an existing list also needs a session opened with a second factor. */
    updateAuthenticatorPolicy: async (orgId: string, body: { allowedAaguids: string[] }, stepUpToken?: string) => {
      return core.request<ApiResponse<OrgAuthenticatorPolicy>>(`/api/organization/${orgId}/authenticator-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /**
     * Turn the requirement on or off, set the grace period, or record that the
     * org's identity provider enforces MFA.
     *
     * `graceDays` only applies while turning the requirement ON — the deadline is
     * computed server-side from it, so the client never posts a date. Step-up
     * gated. LOOSENING (requirement off, admin-actions policy off, "our IdP
     * enforces MFA" on) also needs a session opened with a second factor — a
     * single-factor session gets 401 `MFA_REQUIRED`, which the shell turns into
     * the enrol / sign-in-again dialog. Changing `adminActionsRequireMfa` ends
     * every other member's session so the change applies at once.
     */
    updateMfaPolicy: async (
      orgId: string,
      body: { requireMfa?: boolean; graceDays?: number; idpEnforcesMfa?: boolean; adminActionsRequireMfa?: boolean },
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<OrgMfaPolicy>>(`/api/organization/${orgId}/mfa-policy`, {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // -- MFA recovery: the two-person reset -------------------------------------

    /** Pending (first) and recently decided MFA reset requests for the org and
     *  its teams. Owner/admin only. */
    listMfaResets: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ requests: MfaResetRequest[] }>>(`/api/organization/${orgId}/mfa-resets`, { signal: opts?.signal });
    },
    /** Ask for a member's second factors to be reset. Needs a session opened
     *  with a second factor and a step-up; ANOTHER admin must approve it. */
    requestMfaReset: async (orgId: string, body: { userId: string; reason: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${orgId}/mfa-resets`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Approve someone else's request — removes the member's factors and recovery
     *  codes, ends their sessions and grants an enrolment grace. Needs a step-up
     *  earned with a passkey or an authenticator code. */
    approveMfaReset: async (orgId: string, requestId: string, body: { graceHours?: number }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${orgId}/mfa-resets/${requestId}/approve`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      });
    },
    /** Deny a request (or, as its requester, withdraw it). */
    denyMfaReset: async (orgId: string, requestId: string, body: { note?: string } = {}) => {
      return core.request<ApiResponse<{ request: MfaResetRequest }>>(`/api/organization/${orgId}/mfa-resets/${requestId}/deny`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

export type ImpersonationPolicy = 'open' | 'consent' | 'denied';

/** Resolved impersonation policy — never re-derive defaults or inheritance client-side. */
export interface EffectiveImpersonationPolicyDto {
  policy: ImpersonationPolicy;
  allowSelfApproval: boolean;
  /** The org's own stored setting, before a parent's policy is applied. */
  own: { policy: ImpersonationPolicy; allowSelfApproval: boolean };
  /** Set when a parent org forces a stricter policy than `own`. */
  inheritedFrom?: string;
  /** Display name of `inheritedFrom`, when resolvable. */
  inheritedFromName?: string;
  /** False when the parent couldn't be read; the policy is then the strictest. */
  resolved: boolean;
}

/** A registered org domain as returned to the admin UI. */
export interface OrgDomainDto {
  id: string;
  domain: string;
  verified: boolean;
  autoJoin: 'off' | 'request' | 'auto';
  /** DNS TXT record to publish — present only while unverified. */
  verification?: { host: string; type: string; value: string };
}

/** A pending domain-join request as returned to the admin UI. */
export interface OrgJoinRequestDto {
  id: string;
  userId: string;
  email: string;
  requestedAt: string;
}
