// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse } from '@/types';
import type {
  CatalogEntry, ConsumptionPolicy, CreateInstallBody, InstallPolicyResponse, InstallState, InstallStatusFilter,
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
    /** The in-app catalog: every listed/unmaintained listing with this org's install state (max 200). */
    getPluginCatalog: async (
      params?: { q?: string; category?: string; installed?: boolean },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ listings: CatalogEntry[] }>>(
      `/api/plugins/catalog${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

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
