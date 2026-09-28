// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-reports add-on: saved, scheduled, manager-facing reports.
 *
 * Kept apart from `reporting.ts` because they are different products sold
 * differently. Everything in `reporting.ts` is the FREE on-demand dashboard
 * (`reports:read`); everything here needs the `stakeholder_reports` entitlement
 * and one of the two authoring permissions, so a 403 from this file means
 * "not entitled or not permitted", never "no data".
 */

import type { ApiCore } from '../core';
import type { ApiResponse } from '@/types';

/** How often a definition produces a report. */
export type ReportCadence = 'weekly' | 'monthly' | 'quarterly';
/** The manager-facing templates. */
export type ReportTemplate = 'weekly_delivery' | 'monthly_health' | 'quarterly_review';
/** A run's lifecycle. Nothing reaches a manager before `published`. */
export type ReportRunStatus = 'drafting' | 'ready_for_review' | 'published' | 'failed';
/** Why a definition stopped running — the lead sees this, so it names the fix. */
export type ReportPauseReason = 'entitlement' | 'owner_inactive' | 'permission_lost';

/** What a definition reports on. */
export interface ReportScope {
  kind: 'org' | 'projects' | 'rollup';
  projects?: string[];
}

/** A saved report: what to compute, how often, in whose timezone, for whom. */
export interface ReportDefinition {
  id: string;
  name: string;
  template: ReportTemplate;
  sections: string[];
  cadence: ReportCadence;
  /** IANA name. Periods are cut in THIS zone, not the viewer's. */
  timezone: string;
  weekStart: 'monday' | 'sunday';
  scope: ReportScope;
  /** Recipient ids, not raw addresses. */
  recipients: string[];
  autoSend: boolean;
  isActive: boolean;
  pausedReason: ReportPauseReason | null;
  ownerId: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One period's frozen output. `snapshot` is absent from list responses. */
export interface ReportRun {
  id: string;
  definitionId: string;
  periodStart: string;
  periodEnd: string;
  /** `2026-W38`, `2026-08`, `2026-Q3` — in the definition's timezone. */
  periodLabel: string;
  version: number;
  status: ReportRunStatus;
  leadNotes: string | null;
  aiDraft: string | null;
  failureReason: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  supersededBy: string | null;
  createdAt: string;
  snapshot?: ReportSnapshot | null;
}

/** Which way a metric moved. `unknown` when there is nothing to compare. */
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';

/** One composed section of a snapshot. */
export interface ComposedSection {
  id: string;
  title: string;
  /** `locked` when the org lacks the section's feature; `failed` when it threw. */
  state: 'ok' | 'locked' | 'failed';
  requiresFeature?: string;
  current?: unknown;
  previous?: unknown;
  headline?: { label: string; value: number; unit?: string };
  change?: { absolute: number; percent: number | null; direction: TrendDirection };
}

/** A data-quality caveat attached to the whole snapshot. */
export interface DataQualityNote {
  code: 'missing_deploy_tag' | 'missing_commit_data' | 'low_sample' | 'section_failed' | 'section_locked';
  message: string;
  sectionId?: string;
}

/** The frozen output of one run — what the manager reads. */
export interface ReportSnapshot {
  period: { start: string; end: string; label: string };
  previousPeriod: { start: string; end: string };
  timezone: string;
  weekStart: 'monday' | 'sunday';
  sections: ComposedSection[];
  notes: DataQualityNote[];
  /** How every number was produced. Shown in the footer, not hidden. */
  methodology: string;
  generatedAt: string;
}

/** A read-only public link. The token is returned ONLY when it is minted. */
export interface ReportShareLink {
  id: string;
  runId: string;
  expiresAt: string;
  revokedAt: string | null;
  redactNames: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

/** A delivery address with its state spelled out. */
export interface ReportRecipient {
  id: string;
  email: string;
  displayName: string | null;
  verified: boolean;
  unsubscribed: boolean;
  bounceCount: number;
  approvedBy: string | null;
  /** Whether a send would actually be attempted right now. */
  deliverable: boolean;
  /** Why not, when it would not: `pending_verification`, `unsubscribed`, `bouncing`, `removed`. */
  blockedReason?: string;
  createdAt: string;
}

/** The admin-owned answer to "who may a report reach". */
export interface ReportPolicy {
  /** Whether a lead may mint a public share link at all. Off until an admin opts in. */
  externalSharing: boolean;
  /** Allowed recipient domains; null ⇒ org members only. */
  recipientDomains: string[] | null;
  /** Whether an external address needs an admin's approval before delivery. */
  requireApproval: boolean;
  /**
   * The org's DEFAULTS for a NEW report. Null ⇒ the form falls back to the browser's own
   * timezone, which is both a better guess than the server's and visibly the lead's.
   */
  defaultTimezone: string | null;
  defaultWeekStart: string | null;
}

/** The body of a create; a PUT takes the same fields, all optional. */
export interface ReportDefinitionInput {
  name: string;
  template: ReportTemplate;
  cadence: ReportCadence;
  scope: ReportScope;
  sections?: string[];
  timezone?: string;
  weekStart?: 'monday' | 'sunday';
  recipients?: string[];
  autoSend?: boolean;
}

const BASE = '/api/reports/stakeholder';
/**
 * The free preview's own mount.
 *
 * Separate from `BASE` because it is mounted OUTSIDE the `stakeholder_reports` feature
 * gate — an org that has not bought the add-on must be able to reach it, and every other
 * path here would 403 for them.
 */
const PREVIEW_BASE = '/api/reports/stakeholder-preview';

export function stakeholderReportsApi(core: ApiCore) {
  return {
    // ── Definitions ─────────────────────────────────────────────────────────

    listReportDefinitions: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ definitions: ReportDefinition[] }>>(`${BASE}/definitions`, { signal: opts?.signal }),

    getReportDefinition: async (id: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ definition: ReportDefinition }>>(
        `${BASE}/definitions/${encodeURIComponent(id)}`, { signal: opts?.signal }),

    createReportDefinition: async (body: ReportDefinitionInput) =>
      core.request<ApiResponse<{ definition: ReportDefinition }>>(`${BASE}/definitions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateReportDefinition: async (id: string, body: Partial<ReportDefinitionInput> & { isActive?: boolean }) =>
      core.request<ApiResponse<{ definition: ReportDefinition }>>(`${BASE}/definitions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),

    deleteReportDefinition: async (id: string) =>
      core.request<ApiResponse<{ deleted: boolean }>>(`${BASE}/definitions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    /** Hand a definition to a new owner. A scheduled run is authorized as them. */
    transferReportOwnership: async (id: string, ownerId: string) =>
      core.request<ApiResponse<{ definition: ReportDefinition }>>(
        `${BASE}/definitions/${encodeURIComponent(id)}/transfer`,
        { method: 'POST', body: JSON.stringify({ ownerId }) },
      ),

    /**
     * Whether this instance can send email at all.
     *
     * Asked BEFORE a lead picks recipients, because platform's mailer reports a disabled
     * send as success: without this the form would accept a distribution list on an install
     * that can never mail it, and the lead would find out from a manager. One instance-wide
     * boolean, with no tenant or provider detail in it.
     */
    getReportDeliveryStatus: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ emailAvailable: boolean }>>(`${BASE}/delivery-status`, { signal: opts?.signal }),

    // ── The free preview ────────────────────────────────────────────────────
    //
    // A DIFFERENT base path (`/reports/stakeholder-preview`), because the preview is the
    // one part of this surface deliberately reachable WITHOUT the add-on — the rest sits
    // behind a feature gate that would 403 an org that has not bought it.

    /** Has this org already spent its one free preview? */
    getReportPreviewStatus: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ used: boolean }>>(PREVIEW_BASE, { signal: opts?.signal }),

    /**
     * Spend the org's ONE free preview and return the watermarked snapshot.
     *
     * Nothing is persisted server-side, so there is no run id to open afterwards and
     * nothing to schedule or share — which is what makes those two constraints
     * structural rather than a flag.
     */
    generateReportPreview: async () =>
      core.request<ApiResponse<{
        preview: true; watermark: string; template: string; snapshot: ReportSnapshot;
      }>>(PREVIEW_BASE, { method: 'POST' }),

    // ── Runs ────────────────────────────────────────────────────────────────

    listReportRuns: async (definitionId: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ runs: ReportRun[] }>>(
        `${BASE}/definitions/${encodeURIComponent(definitionId)}/runs`, { signal: opts?.signal }),

    /** Compute a period now. `regenerate` produces version N+1 of an existing one. */
    generateReportRun: async (definitionId: string, body: { period?: string; regenerate?: boolean } = {}) =>
      core.request<ApiResponse<{ run: ReportRun; reused?: boolean }>>(
        `${BASE}/definitions/${encodeURIComponent(definitionId)}/runs`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    getReportRun: async (id: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ run: ReportRun }>>(`${BASE}/runs/${encodeURIComponent(id)}`, { signal: opts?.signal }),

    /**
     * The run as a PDF.
     *
     * `requestBlob` rather than a plain `<a href>`: the session is a bearer token, and a
     * browser navigation carries no Authorization header — the link would 401. It also
     * means a 503 from an instance with no renderer arrives as a normal `ApiError` the UI
     * can explain, instead of as a browser page replacing the app.
     */
    downloadReportRunPdf: async (id: string, fallbackName: string) =>
      core.requestBlob(`${BASE}/runs/${encodeURIComponent(id)}/pdf`, fallbackName),

    /** The lead's own words. Refused once the run is published. */
    saveReportNotes: async (id: string, leadNotes: string) =>
      core.request<ApiResponse<{ run: ReportRun }>>(`${BASE}/runs/${encodeURIComponent(id)}/notes`, {
        method: 'PUT',
        body: JSON.stringify({ leadNotes }),
      }),

    publishReportRun: async (id: string) =>
      core.request<ApiResponse<{
        run: ReportRun;
        recipients: { deliverable: number; blocked: number };
        alreadyPublished: boolean;
        /** Says plainly that a delivered copy cannot be recalled. Shown to the lead. */
        notice: string;
      }>>(`${BASE}/runs/${encodeURIComponent(id)}/publish`, { method: 'POST' }),

    // ── Share links ─────────────────────────────────────────────────────────

    listReportShareLinks: async (runId: string, opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ links: ReportShareLink[] }>>(
        `${BASE}/runs/${encodeURIComponent(runId)}/links`, { signal: opts?.signal }),

    /** The response carries the raw token ONCE. It is never readable again. */
    createReportShareLink: async (runId: string, body: { ttlDays?: number; redactNames?: boolean } = {}) =>
      core.request<ApiResponse<{ link: ReportShareLink; token: string; notice: string }>>(
        `${BASE}/runs/${encodeURIComponent(runId)}/links`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    revokeReportShareLink: async (id: string) =>
      core.request<ApiResponse<{ link: ReportShareLink }>>(`${BASE}/links/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // ── Recipients ──────────────────────────────────────────────────────────

    listReportRecipients: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ recipients: ReportRecipient[] }>>(`${BASE}/recipients`, { signal: opts?.signal }),

    addReportRecipient: async (body: { email: string; displayName?: string }) =>
      core.request<ApiResponse<{
        recipient: ReportRecipient;
        pendingApproval: boolean;
        verificationToken?: string;
      }>>(`${BASE}/recipients`, { method: 'POST', body: JSON.stringify(body) }),

    resendReportRecipientVerification: async (id: string) =>
      core.request<ApiResponse<{ recipient: ReportRecipient; verificationToken: string }>>(
        `${BASE}/recipients/${encodeURIComponent(id)}/resend`, { method: 'POST' }),

    removeReportRecipient: async (id: string) =>
      core.request<ApiResponse<{ deleted: boolean }>>(`${BASE}/recipients/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // ── Org policy (admin) ──────────────────────────────────────────────────

    getReportPolicy: async (opts?: { signal?: AbortSignal }) =>
      core.request<ApiResponse<{ policy: ReportPolicy }>>(`${BASE}/policy`, { signal: opts?.signal }),

    updateReportPolicy: async (body: Partial<ReportPolicy>) =>
      core.request<ApiResponse<{ policy: ReportPolicy }>>(`${BASE}/policy`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
  };
}
