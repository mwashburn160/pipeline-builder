// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery, API_URL } from '../util';
import type { ApiResponse, OrgQuotaResponse, OrgIdpConfigDto, OrgIdpConfigCreate, User, QuotaTier } from '@/types';

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
      offset?: number;
      limit?: number;
    }) => {
      return core.request<ApiResponse<{
        events: Array<{
          _id: string;
          action: string;
          actorId: string;
          actorEmail?: string;
          actorRole?: string;
          orgId?: string;
          affectedOrgId?: string;
          targetType?: string;
          targetId?: string;
          groupId?: string;
          impersonatorId?: string;
          outcome?: 'success' | 'failure';
          details?: Record<string, unknown>;
          ip?: string;
          userAgent?: string;
          requestId?: string;
          traceId?: string;
          createdAt: string;
        }>;
        pagination: { total: number; offset: number; limit: number; hasMore: boolean };
      }>>(`/api/audit${buildQuery(params)}`);
    },

    // ============================================
    // Sysadmin admin-home summary
    // ============================================
    getAdminSummary: async () => {
      return core.request<ApiResponse<{
        orgs: { total: number; perOrgKms: number; ssoEnabled: number };
        users: { total: number; sysadmins: number };
        encryption: { perOrgKmsEnabled: boolean };
        rls: { contextMode: 'warn' | 'strict' | 'silent' };
      }>>('/api/admin/summary');
    },

    // ============================================
    // Per-org IdP config (sysadmin only)
    // ============================================
    getOrgIdpConfig: async (orgId: string) => {
      // `config` is null when the org has no IdP configured (a normal state; the
      // endpoint returns 200, not 404).
      return core.request<ApiResponse<{ config: OrgIdpConfigDto | null }>>(`/api/admin/org-idp/${orgId}`);
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
    getOrgKmsConfig: async (orgId: string) => {
      return core.request<ApiResponse<{ configured: boolean; keyId?: string }>>(
        `/api/admin/orgs/${orgId}/kms-config`,
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
    listUsers: async (params?: { organizationId?: string; role?: string; search?: string; offset?: number; limit?: number }) => {
      return core.request<ApiResponse<{ users: User[]; pagination: { total: number; offset: number; limit: number; hasMore: boolean } }>>(`/api/users${buildQuery(params)}`);
    },

    createUser: async (data: { username: string; email: string; password: string; isSuperAdmin?: boolean; organizationId?: string; role?: 'owner' | 'admin' | 'member'; groupIds?: string[] }) => {
      return core.request<ApiResponse<{ user: { id: string; username: string; email: string } }>>(`/api/users`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    updateUserById: async (id: string, data: { username?: string; email?: string; role?: string; organizationId?: string | null; password?: string }) => {
      return core.request<ApiResponse<{ user: User }>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    deleteUserById: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/users/${id}`, {
        method: 'DELETE',
      });
    },

    /** Start a sysadmin "view as user" impersonation session (read-only).
     *  Backend issues a 15-minute token with `impersonationReadOnly: true`;
     *  the caller swaps it into the api client until "Stop impersonating".
     *  Step-up gated. */
    impersonateUser: async (userId: string, stepUpToken?: string) => {
      return core.request<ApiResponse<{ accessToken: string; expiresIn: number; targetUserId: string }>>(
        `/api/admin/impersonate/${userId}`,
        { method: 'POST', headers: core.stepUpHeader(stepUpToken) },
      );
    },

    /** Sysadmin (or org-admin scoped to their own org) feature-flag overrides
     *  for a user. Backend validates that every key is in ALL_FEATURE_FLAGS
     *  and every value is a boolean. */
    updateUserFeatures: async (userId: string, overrides: Record<string, boolean>) => {
      return core.request<ApiResponse<{ user: User }>>(
        `/api/users/${userId}/features`,
        { method: 'PUT', body: JSON.stringify({ overrides }) },
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
    getOrgQuotas: async (orgId: string) => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`);
    },

    /** Update org name, slug, and/or quotas (system admin only). */
    updateOrgQuotas: async (orgId: string, data: { name?: string; slug?: string; tier?: QuotaTier; quotas?: Record<string, number> }) => {
      return core.request<ApiResponse<{ quota: OrgQuotaResponse }>>(`/api/quota/${orgId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
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
          pipelineArn: string;
          pipelineName: string;
          accountId?: string;
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
  };
}
