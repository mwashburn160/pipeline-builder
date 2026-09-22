// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse } from '@/types';
import type {
  CatalogEntry, ConsumptionPolicy, CreateInstallBody, InstallPolicyResponse, InstallState, InstallStatusFilter,
  InstallChangeRequestBody, InstallChangeRequestView,
  InstallView, ShadowingEntry, UpdateInstallBody,
} from '@/types/plugin-installs';

const enc = encodeURIComponent;

/**
 * Plugin installs, the in-app catalog and the org consumption policy (plugin
 * service, docs/plans/plugin-ecosystem.md W2).
 *
 * `plugins:read` covers the reads; install / upgrade / uninstall need
 * `plugins:install` (which only REQUESTS an install when the org's policy wants
 * approval); approving, denying and editing the policy need
 * `plugin_installs:manage`, and the policy write is step-up gated.
 */
export function pluginInstallsApi(core: ApiCore) {
  return {
    /** One page of the in-app catalog: listed/unmaintained listings with this
     *  org's install state, by name; `total` / `hasMore` say whether there is
     *  more (the server caps a page at 200). */
    getPluginCatalog: async (
      params?: { q?: string; category?: string; installed?: boolean; limit?: number; offset?: number },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ listings: CatalogEntry[]; total: number; limit: number; offset: number; hasMore: boolean }>>(
      `/api/plugins/catalog${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    /** EVERY catalog listing, page by page (for the pipeline editor's resolver,
     *  which must know every installable name — not just the first page). A
     *  bounded number of pages, so a runaway `hasMore` can't loop forever. */
    getAllPluginCatalog: async (opts?: { signal?: AbortSignal }): Promise<CatalogEntry[]> => {
      const out: CatalogEntry[] = [];
      for (let page = 0; page < 50; page += 1) {
        const res = await core.request<ApiResponse<{ listings: CatalogEntry[]; hasMore: boolean }>>(
          `/api/plugins/catalog${buildQuery({ limit: 200, offset: out.length })}`,
          { signal: opts?.signal },
        );
        const rows = res.data?.listings ?? [];
        out.push(...rows);
        if (!res.data?.hasMore || rows.length === 0) break;
      }
      return out;
    },

    /** One listing's install state for this org, with its versions. 404 when the listing doesn't exist. */
    getListingInstallState: async (publisher: string, name: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<InstallState>>(
        `/api/plugins/listings/${enc(publisher)}/${enc(name)}/install-state`,
        { signal: opts?.signal },
      ),

    /** `implicit: true` also returns the virtual Official installs. */
    listPluginInstalls: async (
      params?: { status?: InstallStatusFilter; implicit?: boolean },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ installs: InstallView[]; policy: ConsumptionPolicy }>>(
      `/api/plugins/installs${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    /** 201; `status` is `pending_approval` when the policy asks for approval and the caller can't grant it. */
    createPluginInstall: async (body: CreateInstallBody) =>
      core.request<ApiResponse<{ install: InstallView }>>('/api/plugins/installs', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /** Upgrade or change the version policy. */
    updatePluginInstall: async (id: string, body: UpdateInstallBody) =>
      core.request<ApiResponse<{ install: InstallView }>>(`/api/plugins/installs/${enc(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    /** Uninstall, or withdraw a pending request. `implicitFallback`: an Official listing keeps resolving implicitly. */
    deletePluginInstall: async (id: string) =>
      core.request<ApiResponse<{ removed: true; implicitFallback: boolean }>>(`/api/plugins/installs/${enc(id)}`, {
        method: 'DELETE',
      }),

    approvePluginInstall: async (id: string) =>
      core.request<ApiResponse<{ install: InstallView }>>(`/api/plugins/installs/${enc(id)}/approve`, {
        method: 'POST',
      }),

    denyPluginInstall: async (id: string, reason?: string) =>
      core.request<ApiResponse<{ install: InstallView }>>(`/api/plugins/installs/${enc(id)}/deny`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),

    /** REQUEST an install change that needs an approver (the PATCH refused it
     *  with `details.requestable`). 409 DUPLICATE_ENTRY while one is pending; 400
     *  when the change needs no approval (PATCH it instead). */
    requestInstallChange: async (id: string, body: InstallChangeRequestBody) =>
      core.request<ApiResponse<{ changeRequest: InstallChangeRequestView }>>(`/api/plugins/installs/${enc(id)}/change-requests`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /** The org's pending install changes, oldest first (`plugin_installs:manage`). */
    listInstallChangeRequests: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ changeRequests: InstallChangeRequestView[] }>>('/api/plugins/installs/change-requests', { signal: opts?.signal }),

    approveInstallChange: async (id: string) =>
      core.request<ApiResponse<{ install: InstallView }>>(`/api/plugins/installs/${enc(id)}/change-requests/approve`, {
        method: 'POST',
      }),

    rejectInstallChange: async (id: string, reason?: string) =>
      core.request<ApiResponse<{ install: InstallView }>>(`/api/plugins/installs/${enc(id)}/change-requests/reject`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      }),

    getInstallPolicy: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<InstallPolicyResponse>>('/api/plugins/install-policy', { signal: opts?.signal }),

    /** Any subset of the policy. Step-up gated: pass the token from StepUpModal. */
    updateInstallPolicy: async (body: Partial<ConsumptionPolicy>, stepUpToken?: string) =>
      core.request<ApiResponse<InstallPolicyResponse>>('/api/plugins/install-policy', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Own-org plugins whose names shadow an Official listing the org would otherwise resolve. */
    getPluginShadowing: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ shadowing: ShadowingEntry[] }>>('/api/plugins/shadowing', { signal: opts?.signal }),
  };
}
