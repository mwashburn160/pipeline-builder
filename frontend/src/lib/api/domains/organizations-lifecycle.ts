// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, Organization, PlanTier } from '@/types';
import type { OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import type { OrgTeamRef } from './organizations-hierarchy';

/**
 * Organization lifecycle and identity: the sysadmin list, one org's detail
 * (with a page of its roster), edit, tier change, reparenting, soft-delete /
 * restore, the GDPR export, and the caller's own org.
 * Composed into `organizationsApi` (./organizations).
 */
export function organizationLifecycleApi(core: ApiCore) {
  return {
    // ============================================
    // Organization endpoints
    // ============================================
    /** `opts.signal` cancels the request on the wire (shared query cache / debounced pickers). */
    /** `ids` (comma-joined, ≤ 100) resolves exactly those orgs — for naming
     *  the ids a page shows rather than paging the fleet. */
    listOrganizations: async (params?: { search?: string; tier?: PlanTier; ids?: string; offset?: number; limit?: number }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ organizations: OrganizationListItem[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/organizations${buildQuery(params)}`, { signal: opts?.signal });
    },

    deleteOrganization: async (id: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ deletedAt: string; purgeAfter: string; snapshotId: string }>>(`/api/organization/${encodeURIComponent(id)}`, {
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
      return core.request<ApiResponse<{ organization: { id: string; name: string; membersInvalidated: number } }>>(`/api/organization/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** GET /organization/:id/export — GDPR portability dump. Unlike the other
     *  endpoints this streams a RAW JSON body (application/json + a
     *  Content-Disposition attachment header), NOT the usual `ApiResponse`
     *  envelope, so it returns the body text for the caller to save as a file.
     *  Sysadmin or an org admin/owner (org_settings:write + `canAdministerOrg`).
     *  Step-up gated (a bulk read of every row the org owns): pass the token
     *  the caller's StepUpModal returned. */
    exportOrganization: async (id: string, stepUpToken?: string): Promise<string> => {
      return core.requestText(`/api/organization/${encodeURIComponent(id)}/export`, {
        headers: core.stepUpHeader(stepUpToken),
        timeoutMs: null,
        errorMessage: 'Failed to export organization',
      });
    },

    /** Change an org's pricing tier (sysadmin only). Reseeds quota limits
     *  on the org doc; the quota microservice is NOT updated by this call.
     *  Backend requires step-up because the change affects billing. */
    updateOrganizationTier: async (
      id: string,
      tier: PlanTier,
      stepUpToken?: string,
    ) => {
      return core.request<ApiResponse<{ id: string; previousTier?: string; tier: string }>>(
        `/api/organization/${encodeURIComponent(id)}/tier`,
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
      return core.request<ApiResponse<{ organization: Organization }>>(`/api/organization/${encodeURIComponent(id)}/move`, {
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
      return core.request<ApiResponse<OrganizationDetail>>(`/api/organization/${encodeURIComponent(id)}${buildQuery(params)}`, { signal: opts?.signal });
    },

    /** PUT /organization/:id — sysadmin edit of an org's name, slug and/or
     *  description (the only route that edits the description). Step-up gated:
     *  the caller confirms in a `StepUpModal` and forwards its token. */
    updateOrganization: async (id: string, data: { name?: string; slug?: string; description?: string }, stepUpToken?: string) => {
      return core.request<ApiResponse<{ organization: { id: string; name: string; slug: string; description: string } }>>(
        `/api/organization/${encodeURIComponent(id)}`,
        { method: 'PUT', body: JSON.stringify(data), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** GET /organization — the current user's own organization (any member).
     *  Wrapped in `{ organization }` by the backend (`getMyOrganization`). */
    getMyOrganization: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ organization: Organization }>>('/api/organization', { signal: opts?.signal });
    },

    /** PATCH /organization/:id/identity — self-serve name/slug edit for an org
     *  the caller administers (owner/admin, `org_settings:write`). Distinct from the
     *  sysadmin-only PUT /organization/:id. Provide at least one of name/slug. */
    updateOrganizationIdentity: async (id: string, data: { name?: string; slug?: string }) => {
      return core.request<ApiResponse<{ organization: { id: string; name: string; slug: string; description: string } }>>(
        `/api/organization/${encodeURIComponent(id)}/identity`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        },
      );
    },
  };
}

/** One member of the roster embedded in `GET /organization/:id`. */
export interface OrganizationRosterMember {
  _id: string;
  username?: string;
  email?: string;
  role: OrgRole;
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

/** An org row from the sysadmin list, extended with soft-delete state. The list
 *  endpoint returns soft-deleted orgs inline (NOT filtered out), flagged with
 *  `pendingDeletion` + `deletedAt` so a sysadmin can see and restore them within
 *  the retention window. Absent on rows from other endpoints. */
export interface OrganizationListItem extends Organization {
  pendingDeletion?: boolean;
  deletedAt?: string;
}
