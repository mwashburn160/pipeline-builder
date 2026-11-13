// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';
import type {
  ToolchainAdoptionView, ToolchainAffectedView, ToolchainCanaryView, ToolchainCleanupCandidate,
  ToolchainDefaultHistoryEntry, ToolchainDefaultPreview, ToolchainEligibleView, ToolchainGateThresholds, ToolchainOrgDefault,
  ToolchainOrgDefaultHistoryEntry, ToolchainOrgDefaultView, ToolchainReleasesView, ToolchainRolloutUpdate, ToolchainSetDefaultBody, ToolchainWarning,
} from '@/types/toolchain';

/** `?n=&m=&t=`: the canary-gate thresholds the console is evaluating with (omitted = the server's defaults). */
const thresholdQuery = (t?: ToolchainGateThresholds) => (t ? `?n=${t.n}&m=${t.m}&t=${t.t}` : '');

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

    // -- System org: the Toolchain console (`toolchain:operate`, system org only).
    // Every write also needs a step-up token (`requireStepUp`) and is audited.

    /** Every release with both halves' digests and scans, its status and canary size. */
    listToolchainReleases: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ToolchainReleasesView>>('/api/plugins/toolchain/releases', { signal: opts?.signal }),

    /** Pipelines on a release across all orgs, by `resolvedVia` and per org. */
    getToolchainAdoption: async (releaseVersion: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ToolchainAdoptionView>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/adoption`, { signal: opts?.signal }),

    /** The release's canary members and its §6 gate, judged with `thresholds` when given. */
    getToolchainCanary: async (releaseVersion: string, opts?: { signal?: AbortSignal; thresholds?: ToolchainGateThresholds }) =>
      core.request<ApiResponse<ToolchainCanaryView>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/canary${thresholdQuery(opts?.thresholds)}`, { signal: opts?.signal }),

    /** Replace the release's canary membership with `orgIds`. */
    setToolchainRollout: async (releaseVersion: string, orgIds: string[], stepUpToken?: string) =>
      core.request<ApiResponse<ToolchainRolloutUpdate>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/rollout`, {
        method: 'PUT',
        body: JSON.stringify({ orgIds }),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** What "Set as platform default" would do: the §8 guards and the blast radius. */
    getToolchainDefaultPreview: async (releaseVersion: string, opts?: { signal?: AbortSignal; thresholds?: ToolchainGateThresholds }) =>
      core.request<ApiResponse<ToolchainDefaultPreview>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/default-preview${thresholdQuery(opts?.thresholds)}`, { signal: opts?.signal }),

    /** Promote a release. Refusals: 409 `TOOLCHAIN_DEFAULT_CHANGED`, 4xx `TOOLCHAIN_GUARD_*` (details carry the gate). */
    setToolchainPlatformDefault: async (releaseVersion: string, body: ToolchainSetDefaultBody, stepUpToken?: string) =>
      core.request<ApiResponse<{ platformDefault: string }>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/default`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Edit the release notes shown to orgs. */
    updateToolchainReleaseNotes: async (releaseVersion: string, releaseNotes: string, stepUpToken?: string) =>
      core.request<ApiResponse<unknown>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}`, {
        method: 'PATCH',
        body: JSON.stringify({ releaseNotes }),
        headers: core.stepUpHeader(stepUpToken),
      }),

    deprecateToolchainRelease: async (releaseVersion: string, stepUpToken?: string) =>
      core.request<ApiResponse<unknown>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/deprecate`, {
        method: 'POST',
        body: JSON.stringify({}),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Yank a release. Yanking the default restores the previous one (`restoredDefault`). */
    yankToolchainRelease: async (releaseVersion: string, reason: string, stepUpToken?: string) =>
      core.request<ApiResponse<{ restoredDefault: string | null }>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}/yank`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Delete an unreferenced release (in-use protection applies). */
    deleteToolchainRelease: async (releaseVersion: string, stepUpToken?: string) =>
      core.request<ApiResponse<unknown>>(`/api/plugins/toolchain/releases/${encodeURIComponent(releaseVersion)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** The platform default's history, newest first. */
    getToolchainDefaultHistory: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ history: ToolchainDefaultHistoryEntry[] }>>('/api/plugins/toolchain/history', { signal: opts?.signal }),

    /** §9: pipelines deployed on the release whose latest synth failed, by org. */
    getToolchainAffected: async (releaseVersion: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<ToolchainAffectedView>>(`/api/plugins/toolchain/affected?release=${encodeURIComponent(releaseVersion)}`, { signal: opts?.signal }),

    /** Send each affected owner the redeploy command. */
    notifyToolchainAffected: async (releaseVersion: string, stepUpToken?: string) =>
      core.request<ApiResponse<{ notifiedOrgs: number; notifiedPipelines: number }>>('/api/plugins/toolchain/affected/notify', {
        method: 'POST',
        body: JSON.stringify({ releaseVersion }),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Releases nothing references, older than the last K defaults. */
    getToolchainCleanup: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ candidates: ToolchainCleanupCandidate[] }>>('/api/plugins/toolchain/cleanup', { signal: opts?.signal }),
  };
}
