// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { ApiError } from '../errors';
import { API_URL, buildQuery } from '../util';
import type { ApiResponse } from '@/types';
import type {
  AdvisoryInput, AdvisoryState, AdvisoryView, AutoRule, AutoRuleConditions, EcosystemListingState, EcosystemOverview, EcosystemPublisher, EcosystemRequestDetail,
  ListingView, Publisher, PublisherContext, PublisherInsights, PublishDraft, PublishRequestBody, PublishRequestKind, PublishRequestLane,
  PublishRequestStatus, PublishRequestView, QueueItem, QueueStatusFilter, ReservedName,
} from '@/types/ecosystem';

const enc = encodeURIComponent;
const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/**
 * Plugin-ecosystem routes (plugin service, docs/plans/plugin-ecosystem.md W1).
 *
 * Tenant half: the org's publisher profile, its listings (pause), and the
 * publish REQUESTS it submits — every decision is the system org's (§3.0).
 * Console half (`/plugins/ecosystem/*`): system-org only, aal2 session; the
 * methods that take a `stepUpToken` forward it as `X-Step-Up-Token`.
 */
export function ecosystemApi(core: ApiCore) {
  const post = <T>(path: string, body?: unknown, stepUpToken?: string) =>
    core.request<ApiResponse<T>>(path, {
      method: 'POST',
      ...(body === undefined ? {} : json(body)),
      headers: core.stepUpHeader(stepUpToken),
    });

  return {
    // ── Tenant: publisher profile ─────────────────────────────────────────
    getPublisher: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<PublisherContext>>('/api/plugins/publisher', { signal: opts?.signal }),

    createPublisher: async (body: {
      handle: string; displayName: string; description?: string; homepageUrl?: string; termsVersion: string;
    }) => post<{ publisher: Publisher }>('/api/plugins/publisher', body),

    /** Description and homepage are edited directly (post-moderated); handle and
     *  display name change only through a `profile_change` request. */
    updatePublisher: async (body: { description?: string | null; homepageUrl?: string | null }) =>
      core.request<ApiResponse<{ publisher: Publisher }>>('/api/plugins/publisher', { method: 'PATCH', ...json(body) }),

    acceptPublisherTerms: async (termsVersion: string) =>
      post<{ publisher: Publisher }>('/api/plugins/publisher/terms', { termsVersion }),

    // ── Tenant: listings ──────────────────────────────────────────────────
    listPublisherListings: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ listings: ListingView[] }>>('/api/plugins/publisher/listings', { signal: opts?.signal }),

    /** Pause a listing (no `version`) or one version — immediate; unpausing is a request. */
    pauseListing: async (listingId: string, version?: string) =>
      post<{ listing: ListingView }>(`/api/plugins/publisher/listings/${enc(listingId)}/pause`, version ? { version } : {}),

    /** Deprecate one listed version — immediate (it only narrows); there is no tenant un-deprecate. */
    deprecateListingVersion: async (listingId: string, version: string, message: string) =>
      post<{ listing: ListingView }>(`/api/plugins/publisher/listings/${enc(listingId)}/deprecate`, { version, message }),

    /** Per-listing installs, k-anonymous adoption, success rate, rating trend, reports, advisories and health (W7). */
    getPublisherInsights: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<PublisherInsights>>('/api/plugins/publisher/insights', { signal: opts?.signal }),

    /** The publisher's own advisories in every state (drafts are private until the system org publishes them). */
    listPublisherAdvisories: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ advisories: AdvisoryView[] }>>('/api/plugins/publisher/advisories', { signal: opts?.signal }),

    listIncomingTransfers: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ requests: PublishRequestView[] }>>('/api/plugins/publisher/incoming-transfers', { signal: opts?.signal }),

    // ── Tenant: publish requests ──────────────────────────────────────────
    listPublishRequests: async (params?: { status?: PublishRequestStatus }, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ requests: PublishRequestView[] }>>(
        `/api/plugins/publish-requests${buildQuery(params)}`,
        { signal: opts?.signal },
      ),

    getPublishDraft: async (pluginId: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<PublishDraft>>(
        `/api/plugins/publish-requests/draft${buildQuery({ pluginId })}`,
        { signal: opts?.signal },
      ),

    submitPublishRequest: async (body: PublishRequestBody) =>
      post<{ request: PublishRequestView; autoApproved: boolean }>('/api/plugins/publish-requests', body),

    withdrawPublishRequest: async (id: string) =>
      post<{ request: PublishRequestView }>(`/api/plugins/publish-requests/${enc(id)}/withdraw`),

    respondToTransfer: async (id: string, accept: boolean, stepUpToken?: string) =>
      post<{ request: PublishRequestView }>(`/api/plugins/publish-requests/${enc(id)}/transfer-response`, { accept }, stepUpToken),

    // ── Console: queue ────────────────────────────────────────────────────
    getEcosystemOverview: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<EcosystemOverview>>('/api/plugins/ecosystem/overview', { signal: opts?.signal }),

    listEcosystemRequests: async (
      params?: { status?: QueueStatusFilter; kind?: PublishRequestKind; lane?: PublishRequestLane; limit?: number },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ requests: QueueItem[] }>>(
      `/api/plugins/ecosystem/requests${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    getEcosystemRequest: async (id: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<EcosystemRequestDetail>>(
        `/api/plugins/ecosystem/requests/${enc(id)}`,
        { signal: opts?.signal },
      ),

    /** A two-person request comes back `pending_second_approval` after the first approval. */
    approveEcosystemRequest: async (id: string, note?: string, stepUpToken?: string) =>
      post<{ request: QueueItem }>(
        `/api/plugins/ecosystem/requests/${enc(id)}/approve`, note ? { note } : {}, stepUpToken,
      ),

    secondApproveEcosystemRequest: async (id: string, note?: string, stepUpToken?: string) =>
      post<{ request: QueueItem }>(
        `/api/plugins/ecosystem/requests/${enc(id)}/second-approve`, note ? { note } : {}, stepUpToken,
      ),

    rejectEcosystemRequest: async (id: string, reason: string) =>
      post<{ request: QueueItem }>(`/api/plugins/ecosystem/requests/${enc(id)}/reject`, { reason }),

    // ── Console: publishers ───────────────────────────────────────────────
    listEcosystemPublishers: async (
      params?: { tier?: string; suspended?: boolean; q?: string },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ publishers: EcosystemPublisher[] }>>(
      `/api/plugins/ecosystem/publishers${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    suspendPublisher: async (id: string, reason: string, stepUpToken?: string) =>
      post<{ publisher: Publisher }>(`/api/plugins/ecosystem/publishers/${enc(id)}/suspend`, { reason }, stepUpToken),

    /** Two-person: returns the request awaiting a second approver. */
    unsuspendPublisher: async (id: string, reason: string | undefined, stepUpToken?: string) =>
      post<{ request: QueueItem }>(
        `/api/plugins/ecosystem/publishers/${enc(id)}/unsuspend`, reason ? { reason } : {}, stepUpToken,
      ),

    /** To `verified`: a two-person request. To `community`: applied at once. */
    setPublisherTier: async (id: string, tier: 'verified' | 'community', reason: string, stepUpToken?: string) =>
      post<{ request?: QueueItem; publisher?: Publisher }>(
        `/api/plugins/ecosystem/publishers/${enc(id)}/tier`, { tier, reason }, stepUpToken,
      ),

    // ── Console: listings ─────────────────────────────────────────────────
    listEcosystemListings: async (
      params?: { state?: EcosystemListingState; q?: string; publisherId?: string },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ listings: ListingView[] }>>(
      `/api/plugins/ecosystem/listings${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    /** Lifting a suspension returns a two-person `request` instead of the listing. */
    setListingState: async (
      id: string, state: 'listed' | 'unmaintained' | 'suspended', reason: string, stepUpToken?: string,
    ) => post<{ listing?: ListingView; request?: QueueItem }>(
      `/api/plugins/ecosystem/listings/${enc(id)}/state`, { state, reason }, stepUpToken,
    ),

    yankListingVersion: async (id: string, version: string, reason: string, stepUpToken?: string) =>
      post<{ listing: ListingView }>(
        `/api/plugins/ecosystem/listings/${enc(id)}/versions/${enc(version)}/yank`, { reason }, stepUpToken,
      ),

    /** Two-person: returns the request awaiting a second approver. */
    requestUnyankListingVersion: async (id: string, version: string, reason: string, stepUpToken?: string) =>
      post<{ request: QueueItem }>(
        `/api/plugins/ecosystem/listings/${enc(id)}/versions/${enc(version)}/unyank`, { reason }, stepUpToken,
      ),

    /** Deprecate a version (`message` optional) or clear it (`deprecated: false`). */
    setListingVersionDeprecation: async (
      id: string, version: string, body: { message?: string; deprecated?: boolean }, stepUpToken?: string,
    ) => post<{ listing: ListingView }>(
      `/api/plugins/ecosystem/listings/${enc(id)}/versions/${enc(version)}/deprecate`, body, stepUpToken,
    ),

    // ── Console: advisories ───────────────────────────────────────────────
    listEcosystemAdvisories: async (
      params?: { state?: AdvisoryState; listingId?: string },
      opts?: { signal?: AbortSignal },
    ) => core.request<ApiResponse<{ advisories: AdvisoryView[] }>>(
      `/api/plugins/ecosystem/advisories${buildQuery(params)}`,
      { signal: opts?.signal },
    ),

    /** A moderator-created DRAFT; publishing it = approving `request`. */
    createEcosystemAdvisory: async (body: AdvisoryInput & { listingId: string }, stepUpToken?: string) =>
      post<{ advisory: AdvisoryView; request: PublishRequestView }>('/api/plugins/ecosystem/advisories', body, stepUpToken),

    /** Drafts only (409 otherwise). */
    updateEcosystemAdvisory: async (id: string, body: Partial<AdvisoryInput>, stepUpToken?: string) =>
      core.request<ApiResponse<{ advisory: AdvisoryView }>>(`/api/plugins/ecosystem/advisories/${enc(id)}`, {
        method: 'PATCH',
        ...json(body),
        headers: core.stepUpHeader(stepUpToken),
      }),

    /** Published only: clears the lookup warning / block and notifies installers. */
    withdrawEcosystemAdvisory: async (id: string, reason: string, stepUpToken?: string) =>
      post<{ advisory: AdvisoryView }>(`/api/plugins/ecosystem/advisories/${enc(id)}/withdraw`, { reason }, stepUpToken),

    /** Queue a trust re-sign of every published `public/*` image (after a
     *  plugin-signing key rotation — docs/runbooks/secret-rotation.md). */
    resignAllPublishedImages: async (reason: string, stepUpToken?: string) =>
      post<{ queued: number }>('/api/plugins/ecosystem/resign', { reason }, stepUpToken),

    // ── Console: auto-approval rules ──────────────────────────────────────
    listAutoRules: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ rules: AutoRule[] }>>('/api/plugins/ecosystem/rules', { signal: opts?.signal }),

    /** Created disabled, with the proposal awaiting a second approver. */
    createAutoRule: async (body: { name: string; conditions: AutoRuleConditions }, stepUpToken?: string) =>
      post<{ rule: AutoRule }>('/api/plugins/ecosystem/rules', body, stepUpToken),

    /** Disabling applies at once; enabling or changing conditions becomes `pendingChange`. */
    updateAutoRule: async (
      id: string,
      body: { name?: string; enabled?: boolean; conditions?: AutoRuleConditions },
      stepUpToken?: string,
    ) => core.request<ApiResponse<{ rule: AutoRule }>>(`/api/plugins/ecosystem/rules/${enc(id)}`, {
      method: 'PATCH',
      ...json(body),
      headers: core.stepUpHeader(stepUpToken),
    }),

    approveAutoRuleChange: async (id: string, stepUpToken?: string) =>
      post<{ rule: AutoRule }>(`/api/plugins/ecosystem/rules/${enc(id)}/approve-change`, undefined, stepUpToken),

    deleteAutoRule: async (id: string, stepUpToken?: string) =>
      core.request<ApiResponse<{ deleted: true }>>(`/api/plugins/ecosystem/rules/${enc(id)}`, {
        method: 'DELETE',
        headers: core.stepUpHeader(stepUpToken),
      }),

    // ── Console: reserved names ───────────────────────────────────────────
    listReservedNames: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ names: ReservedName[] }>>('/api/plugins/ecosystem/reserved-names', { signal: opts?.signal }),

    /** Reserve (or re-reason) a handle / listing name; `publisherId` makes it claimable by that publisher only. */
    putReservedName: async (name: string, body: { reason?: string | null; publisherId?: string | null }) =>
      core.request<ApiResponse<Omit<ReservedName, 'createdAt'>>>(`/api/plugins/ecosystem/reserved-names/${enc(name)}`, {
        method: 'PUT',
        ...json(body),
      }),

    deleteReservedName: async (name: string) =>
      core.request<ApiResponse<{ deleted: true }>>(`/api/plugins/ecosystem/reserved-names/${enc(name)}`, { method: 'DELETE' }),

    // ── Console: community submissions (W5) ───────────────────────────────
    /**
     * Download a console artifact the server linked (a submission's SBOM or
     * scan report). Only console paths are fetched — the link comes from the
     * server, but it is never allowed to point the session's token elsewhere.
     */
    /** The quarantined build's SBOM / scan report paths for a `submission` request (W5), for downloadEcosystemArtifact. */
    submissionArtifactPath: (requestId: string, kind: 'sbom' | 'scan'): string => (kind === 'sbom'
      ? `/api/plugins/ecosystem/requests/${enc(requestId)}/submission-sbom`
      : `/api/plugins/ecosystem/requests/${enc(requestId)}/submission-scan`),
    downloadEcosystemArtifact: async (path: string, fallbackName: string): Promise<{ blob: Blob; filename: string }> => {
      if (!path.startsWith('/api/plugins/ecosystem/') || path.includes('..')) {
        throw new ApiError('Refusing to download from outside the Ecosystem console API', 400, 'VALIDATION_ERROR');
      }
      await core.ensureFreshToken();
      const res = await fetch(`${API_URL}${path}`, {
        headers: core.authHeaders() as Record<string, string>,
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { code?: string; message?: string };
        throw new ApiError(data.message || 'Download failed', res.status, data.code);
      }
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
      return { blob: await res.blob(), filename: match?.[1] ?? fallbackName };
    },
  };
}
