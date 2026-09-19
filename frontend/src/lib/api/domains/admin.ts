// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import type { ApiResponse, OrgQuotaResponse, OrgIdpConfigDto, OrgIdpConfigCreate, User, QuotaTier, QuotaType } from '@/types';
import type { AuditLogEvent, AuditChainVerification } from '@/types/audit';

export function adminApi(core: ApiCore) {
  return {
    // ============================================
    // Audit events (sysadmin / org-admin)
    // ============================================
    listAuditEvents: async (params?: {
      orgId?: string;
      affectedOrgId?: string;
      actorId?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      groupId?: string;
      impersonatorId?: string;
      requestId?: string;
      outcome?: 'success' | 'failure';
      /** Inclusive createdAt range bounds (ISO date strings). */
      from?: string;
      to?: string;
      offset?: number;
      limit?: number;
    }, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{
        events: AuditLogEvent[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/audit${buildQuery(params)}`, { signal: opts?.signal });
    },

    /**
     * Verify the hash-chain integrity of an org's audit log (sysadmin only).
     * Returns `{ ok: true }` when the chain hashes cleanly end-to-end, or
     * `{ ok: false, brokenAt }` pointing at the first tampered/broken link.
     */
    verifyAuditChain: async (orgId: string) => {
      return core.request<ApiResponse<AuditChainVerification>>(
        `/api/audit/verify${buildQuery({ orgId })}`,
      );
    },

    // ============================================
    // Sysadmin admin-home summary
    // ============================================
    getAdminSummary: async (opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{
        orgs: { total: number; perOrgKms: number; ssoEnabled: number };
        users: { total: number; sysadmins: number };
        encryption: { perOrgKmsEnabled: boolean };
        rls: { contextMode: 'warn' | 'strict' | 'silent' };
      }>>('/api/admin/summary', { signal: opts?.signal });
    },

    // ============================================
    // Per-org IdP config (sysadmin only)
    // ============================================
    getOrgIdpConfig: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      // `config` is null when the org has no IdP configured (a normal state; the
      // endpoint returns 200, not 404).
      return core.request<ApiResponse<{ config: OrgIdpConfigDto | null }>>(`/api/admin/org-idp/${orgId}`, { signal: opts?.signal });
    },

    putOrgIdpConfig: async (orgId: string, data: OrgIdpConfigCreate) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto }>>(`/api/admin/org-idp/${orgId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    patchOrgIdpConfig: async (orgId: string, data: Partial<OrgIdpConfigCreate>) => {
      return core.request<ApiResponse<{ config: OrgIdpConfigDto }>>(`/api/admin/org-idp/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    },

    deleteOrgIdpConfig: async (orgId: string) => {
      return core.request<ApiResponse<Record<string, never>>>(`/api/admin/org-idp/${orgId}`, {
        method: 'DELETE',
      });
    },

    // ============================================
    // Per-org KMS config (sysadmin only)
    // ============================================
    /** Get the org's KMS config status. Returns only the keyId — ciphertext
     *  is intentionally elided server-side. */
    getOrgKmsConfig: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ configured: boolean; keyId?: string }>>(
        `/api/admin/orgs/${orgId}/kms-config`,
        { signal: opts?.signal },
      );
    },

    /** Upsert the org's KMS config. The PUT path triggers three-phase
     *  re-encryption of existing secrets unless `reencrypt=false` is passed. */
    putOrgKmsConfig: async (
      orgId: string,
      data: { keyId: string; ciphertextBase64: string },
      opts?: { reencrypt?: boolean },
      stepUpToken?: string,
    ) => {
      const q = opts?.reencrypt === false ? '?reencrypt=false' : '';
      return core.request<ApiResponse<{ configured: boolean; keyId: string; aiKeysReencrypted?: number; idpSecretReencrypted?: boolean }>>(
        `/api/admin/orgs/${orgId}/kms-config${q}`,
        { method: 'PUT', body: JSON.stringify(data), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Clear the org's KMS config — org reverts to the shared master. */
    deleteOrgKmsConfig: async (orgId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ configured: boolean }>>(
        `/api/admin/orgs/${orgId}/kms-config`,
        { method: 'DELETE', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Dry-run a proposed KMS config without touching Mongo. Verifies the
     *  CMK exists, IAM permits Decrypt, and the wrapped master is valid. */
    testOrgKmsConfig: async (orgId: string, data: { keyId: string; ciphertextBase64: string }) => {
      return core.request<ApiResponse<{ ok: boolean; keyId: string; keyFingerprint: string; message: string }>>(
        `/api/admin/orgs/${orgId}/kms-config/test`,
        { method: 'POST', body: JSON.stringify(data) },
      );
    },

    // ============================================
    // User grants (sysadmin only) — generic path keeps the privilege
    // surface from being telegraphed in access logs.
    // ============================================
    /** Grant a named privilege to a user (today: 'platform-admin'). */
    addUserGrant: async (userId: string, grant: 'platform-admin', stepUpToken?: string) => {
      return core.request<ApiResponse<{ userId: string; grant: string; changed: boolean }>>(
        `/api/admin/users/${userId}/grants`,
        { method: 'POST', body: JSON.stringify({ grant }), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Revoke a named privilege from a user. Self-revoke is rejected
     *  server-side to prevent lockout. */
    removeUserGrant: async (userId: string, grant: 'platform-admin', stepUpToken?: string) => {
      return core.request<ApiResponse<{ userId: string; grant: string; changed: boolean }>>(
        `/api/admin/users/${userId}/grants`,
        { method: 'DELETE', body: JSON.stringify({ grant }), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    // ============================================
    // Per-org k8s namespace manifest (sysadmin only).
    // Render-only — operator pipes the response to `kubectl apply -f -`.
    // ============================================
    /** Fetch the templated namespace YAML as a downloadable string. */
    getOrgNamespaceYaml: async (orgId: string, stepUpToken?: string): Promise<string> => {
      await core.ensureFreshToken();
      const res = await fetch(`${API_URL}/api/admin/orgs/${orgId}/k8s-namespace.yaml`, {
        headers: { ...core.authHeaders(), ...core.stepUpHeader(stepUpToken) } as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`Failed to fetch namespace YAML: ${res.status} ${res.statusText}`);
      return res.text();
    },

    // ============================================
    // User management endpoints (Admin)
    // ============================================
    /** GET /users/:id — one user's current record (members:manage; an org-admin
     *  only for a user sharing their org). Opening a user reads this rather than
     *  trusting the list row, which may be stale. */
    getUser: async (id: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ user: User }>>(`/api/users/${id}`, { signal: opts?.signal });
    },

    listUsers: async (params?: { organizationId?: string; role?: string; search?: string; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ users: User[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/users${buildQuery(params)}`);
    },

    createUser: async (data: { username: string; email: string; password: string; isSuperAdmin?: boolean; organizationId?: string; role?: 'owner' | 'admin' | 'member'; roleIds?: string[] }) => {
      return core.request<ApiResponse<{ user: { id: string; username: string; email: string } }>>(`/api/users`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    /** Platform admins only for username/email/password; requires a fresh password check. */
    updateUserById: async (
      id: string,
      data: { username?: string; email?: string; role?: string; organizationId?: string | null; password?: string },
      stepUpToken: string,
    ) => {
      return core.request<ApiResponse<{ user: User }>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Deletes the whole account (platform admins only); requires a fresh password check. */
    deleteUserById: async (id: string, stepUpToken: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/users/${id}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    /** Start a sysadmin "view as user" impersonation session (read-only).
     *  Backend issues a 15-minute token with `impersonationReadOnly: true`;
     *  the caller swaps it into the api client until "Stop impersonating".
     *  Step-up gated. */
    impersonateUser: async (
      userId: string,
      stepUpToken?: string,
      options: {
        reason?: string;
        /** The organization the session is for. A parent-org admin names the
         *  team the member was picked from; without it the server uses the
         *  member's last active org, which may be the parent itself. */
        orgId?: string;
      } = {},
    ) => {
      // `accessToken` is present only when the request was approved on creation.
      // Under a consent policy it is absent and `status` is `pending`: the caller
      // must wait for approval, then open the session from Access requests.
      const body = {
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.orgId ? { orgId: options.orgId } : {}),
      };
      return core.request<ApiResponse<ImpersonationStartDto>>(
        `/api/admin/impersonate/${userId}`,
        {
          method: 'POST',
          headers: core.stepUpHeader(stepUpToken),
          ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
        },
      );
    },

    /** Requests the caller can act on — filtered server-side by the same rules as
     *  decide and revoke, so it never shows what you couldn't act on. */
    listImpersonationRequests: async (
      view: ImpersonationListView,
      page?: { limit?: number; offset?: number },
      opts?: { signal?: AbortSignal },
    ) => {
      return core.request<ApiResponse<{
        requests: ImpersonationRequestDto[];
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/admin/impersonate/requests${buildQuery({ view, ...page })}`, { signal: opts?.signal });
    },

    /** Approve or deny a pending request. */
    decideImpersonationRequest: async (requestId: string, approve: boolean) => {
      return core.request<ApiResponse<{ requestId: string; status: string }>>(
        `/api/admin/impersonate/requests/${requestId}/decide`,
        { method: 'POST', body: JSON.stringify({ approve }) },
      );
    },

    /** End a live session early. Not step-up gated: stopping access must never be
     *  harder than allowing it. */
    revokeImpersonationSession: async (requestId: string) => {
      // `revokedEverywhere: false` means the platform refuses the token but other
      // services may still accept it until it expires — tell the person that.
      return core.request<ApiResponse<{ requestId: string; status: 'revoked'; revokedEverywhere: boolean }>>(
        `/api/admin/impersonate/requests/${requestId}/revoke`,
        { method: 'POST' },
      );
    },

    /** Exchange an approved request for its session token. Step-up gated. */
    redeemImpersonationRequest: async (requestId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<ImpersonationStartDto>>(
        `/api/admin/impersonate/requests/${requestId}/redeem`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Emergency access over an org's policy. Sysadmin only; a written
     *  justification is required and shown to the org. May come back `pending`
     *  (202) when a second sysadmin must approve. */
    breakglassImpersonation: async (userId: string, justification: string, stepUpToken?: string) => {
      return core.request<ApiResponse<ImpersonationStartDto>>(
        `/api/admin/impersonate/${userId}/breakglass`,
        { method: 'POST', body: JSON.stringify({ justification }), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Sysadmin (or org-admin scoped to their own org) feature-flag overrides
     *  for a user. Backend validates that every key is in ALL_FEATURE_FLAGS
     *  and every value is a boolean. */
    /** Replace a user's feature overrides; requires a fresh password check (step-up). */
    updateUserFeatures: async (userId: string, overrides: Record<string, boolean>, stepUpToken: string) => {
      return core.request<ApiResponse<{ user: User }>>(
        `/api/users/${userId}/features`,
        { method: 'PUT', body: JSON.stringify({ overrides }), headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Bulk delete users (sysadmin only). Returns per-id success/failure
     *  so the caller can surface partial-success summaries. */
    bulkDeleteUsers: async (ids: string[], stepUpToken?: string) => {
      return core.request<ApiResponse<{
        summary: { requested: number; deleted: number; failed: number };
        results: Array<{ id: string; ok: boolean; error?: string; affectedOrgId?: string }>;
      }>>('/api/users/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ ids }),
        headers: core.stepUpHeader(stepUpToken),
      });
    },

    // ============================================
    // Quota endpoints (quota service — nginx proxies /api/quota → quota:3000/quotas)
    // ============================================

    /** Get quotas for the requesting user's org (from JWT). */
    getOwnQuotas: async () => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>('/api/quota');
    },

    /** Get all orgs with quotas (system admin only). */
    getAllOrgQuotas: async () => {
      return core.request<ApiResponse<{ organizations: OrgQuotaResponse[]; total: number }>>('/api/quota/all');
    },

    /** Get quotas for a specific org. */
    getOrgQuotas: async (orgId: string, opts?: { signal?: AbortSignal }) => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`, { signal: opts?.signal });
    },

    /** Update org name, slug, and/or quotas (system admin only). */
    updateOrgQuotas: async (orgId: string, data: { name?: string; slug?: string; tier?: QuotaTier; quotas?: Record<string, number> }) => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /**
     * Reset an org's usage counters mid-period (system admin only). Zeroes the
     * consumed side of the quota without touching limits — used when a support
     * action or migration should give an org a clean slate before the natural
     * period reset. Omit `quotaType` to reset every counter; pass one to reset
     * a single dimension. Returns the org's quotas with the reset applied.
     */
    resetOrgQuota: async (orgId: string, quotaType?: QuotaType) => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}/reset`, {
        method: 'POST',
        body: JSON.stringify(quotaType ? { quotaType } : {}),
      });
    },

    /**
     * List the pipeline registry rows for the caller's org. Each row is an
     * ARN→pipelineId mapping written by CDK at deploy time. Powers the
     * dashboard "deployed pipelines" panel; the `pipeline-manager
     * audit-stacks` CLI joins this against live CloudFormation to find drift.
     */
    listPipelineRegistry: async (params?: { limit?: number; offset?: number }) => {
      return core.request<ApiResponse<{
        registry: Array<{
          id: string;
          pipelineId: string;
          orgId: string;
          pipelineName: string;
          // NOTE: the server never returns an AWS account id or pipeline ARN
          // (scrubbed by design — see the no-account-id invariant). Do not
          // re-add `pipelineArn`/`accountId` here.
          region?: string;
          project?: string;
          organization?: string;
          stackName?: string;
          lastDeployed: string;
          createdAt: string;
          updatedAt: string;
        }>;
        pagination: { total: number; limit: number; offset: number; hasMore: boolean };
      }>>(`/api/pipelines/registry${buildQuery(params)}`);
    },

    /**
     * Delete a single pipeline registry row by UUID (org-scoped on the server).
     * Used to reconcile drift after a CloudFormation stack is removed out-of-band.
     */
    deletePipelineRegistry: async (id: string) => {
      return core.request<ApiResponse<{ id: string }>>(`/api/pipelines/registry/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    /**
     * List orgs at >= threshold% on any quota dimension (system admin only).
     * Powers the operations dashboard "orgs about to hit limits" panel.
     * @param threshold integer 1-100 (default 80 server-side)
     */
    getAtRiskQuotas: async (threshold?: number) => {
      const qs = threshold ? `?threshold=${threshold}` : '';
      return core.request<ApiResponse<{
        atRisk: Array<{
          orgId: string;
          name: string;
          slug: string;
          tier?: string;
          type: 'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls';
          used: number;
          limit: number;
          percent: number;
        }>;
        count: number;
        threshold: number;
      }>>(`/api/quota/at-risk${qs}`);
    },

    /**
     * Account-scoped at-risk quota dimensions for a SINGLE org (the caller's
     * own). Unlike {@link getAtRiskQuotas} (sysadmin, cross-tenant) this is
     * gated by tenancy on the server — a non-sysadmin can only read their own
     * org — so an org owner/admin can see what's near cap without sysadmin.
     * For pooled/hierarchy orgs the numbers are the root's pooled cap + subtree
     * usage, matching enforcement.
     * @param threshold integer 1-100 (default 80 server-side)
     */
    getOrgAtRisk: async (orgId: string, threshold?: number) => {
      const qs = threshold ? `?threshold=${threshold}` : '';
      return core.request<ApiResponse<{
        atRisk: Array<{
          orgId: string;
          name: string;
          slug: string;
          tier?: string;
          type: 'plugins' | 'pipelines' | 'apiCalls' | 'aiCalls';
          used: number;
          limit: number;
          percent: number;
        }>;
        count: number;
        total: number;
        threshold: number;
        orgId: string;
      }>>(`/api/quota/${encodeURIComponent(orgId)}/at-risk${qs}`);
    },
  };
}

/** The three views of impersonation requests. */
export type ImpersonationListView = 'to-decide' | 'mine' | 'sessions';

/** Result of starting, redeeming, or break-glassing a session. */
export interface ImpersonationStartDto {
  requestId: string;
  status: 'consumed' | 'pending';
  /** Present only once a token was issued. */
  accessToken?: string;
  expiresIn?: number;
  targetUserId?: string;
  /** Break-glass awaiting a second sysadmin. */
  awaiting?: 'second_sysadmin';
  reason?: 'policy_denied' | 'rate_limit';
}

/** An impersonation request as shown to a person. The session token id is never sent. */
export interface ImpersonationRequestDto {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired' | 'revoked' | 'undeliverable';
  breakglass: boolean;
  approvalReason?: 'policy_open' | 'ancestor_authority' | 'consent' | 'breakglass';
  approverMode?: 'user' | 'org_admin';
  orgId?: string;
  /** Written by the requesting operator. Render as TEXT, never as markup. */
  reason?: string;
  requester: { id: string; name: string };
  target: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  decidedAt?: string;
}
