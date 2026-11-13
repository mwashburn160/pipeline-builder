// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';
import type {
  ToolchainEligibleView, ToolchainOrgDefault, ToolchainOrgDefaultHistoryEntry, ToolchainOrgDefaultView, ToolchainWarning,
} from '@/types/toolchain';

/**
 * The managed pipeline toolchain, from the caller's own org (plugin service;
 * docs/plans/bootstrap-image-versioning.md §5).
 *
 * Reads need `pipelines:read`. The org-default writes need `toolchain:manage`
 * and a step-up token (`requireStepUp`, always on), and only accept an
 * eligible release (400 `TOOLCHAIN_RELEASE_NOT_ELIGIBLE`).
 */
export function toolchainApi(core: ApiCore) {
  return {
    /** The org's effective release and why, its own default, canary state and pipeline counts. */
    getToolchainOrgDefault: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ToolchainOrgDefaultView>>('/api/plugins/toolchain/org-default', { signal: opts?.signal }),

    /** Set the org default. `warnings` names anything worth knowing that is not a refusal (e.g. a later-found vulnerability). */
    setToolchainOrgDefault: async (body: { releaseVersion: string; reason?: string }, stepUpToken?: string) =>
      core.request<ApiResponse<{ orgDefault: ToolchainOrgDefault; warnings?: ToolchainWarning[] }>>('/api/plugins/toolchain/org-default', {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Follow the platform default again (or, for a team, inherit the root org's). */
    clearToolchainOrgDefault: async (stepUpToken?: string) =>
      core.request<ApiResponse<{ orgDefault: null }>>('/api/plugins/toolchain/org-default', {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** The org default's history, newest first. */
    getToolchainOrgDefaultHistory: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ history: ToolchainOrgDefaultHistoryEntry[] }>>('/api/plugins/toolchain/org-default/history', { signal: opts?.signal }),

    /** The releases this caller may pin or set as the org default (D15). Never
     *  yanked or deprecated ones: a current pin / org default that is no longer
     *  eligible is absent here and the UI shows it as "(no longer offered)". */
    getToolchainEligible: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ToolchainEligibleView>>('/api/plugins/toolchain/eligible', { signal: opts?.signal }),
  };
}
