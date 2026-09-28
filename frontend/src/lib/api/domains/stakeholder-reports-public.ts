// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ANONYMOUS half of the stakeholder-reports client.
 *
 * Its own file, apart from `stakeholder-reports.ts`, for the same reason the
 * plugin ecosystem splits its public clients out: this one deliberately carries
 * NO credentials and does not go through the authenticated fetch core, so mixing
 * it into a file of session calls would make it easy to reach for by accident.
 * It uses the single credential-free helper (`../anonymous`) rather than calling
 * `fetch` itself.
 */
import { anonymousRequest } from '../anonymous';

/**
 * Confirm a report recipient's own delivery address with the single-use token
 * from the confirmation email.
 *
 * Anonymous by necessity: the manager a report is for usually has no account
 * here. Called only from an explicit button press — never on page load — so a
 * mail scanner that opens the link cannot consume the token before the person
 * ever clicks it (which would tell them the link was already used).
 */
export function confirmReportRecipientEmail(token: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
  return anonymousRequest<unknown>('/api/public/report-recipients/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: opts.signal,
  });
}

/**
 * Stop this address receiving an organization's reports.
 *
 * The token rides the QUERY STRING, not the body, because the same URL is what the
 * `List-Unsubscribe` header carries and RFC 8058 fixes the one-click body to
 * `List-Unsubscribe=One-Click`. So the mail client's own unsubscribe button and this
 * page hit exactly one endpoint, and there is no second code path to keep in step.
 */
export function unsubscribeFromReports(token: string, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
  return anonymousRequest<unknown>(
    `/api/public/report-recipients/unsubscribe?token=${encodeURIComponent(token)}`,
    { method: 'POST', signal: opts.signal },
  );
}

/** One published period, as a share link's holder reads it. */
export interface SharedReport {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  publishedAt: string | null;
  leadNotes: string | null;
  snapshot: { sections: Array<Record<string, unknown>>; notes?: unknown[]; methodology?: string } | null;
  namesRedacted: boolean;
}

/**
 * Read a shared report with the token from its link.
 *
 * Anonymous by necessity — the managers a report is written for are usually not provisioned
 * into the platform, which is the whole reason share links exist. Every failure comes back
 * as the same 404, so this cannot distinguish an expired link from a revoked one or from a
 * token that never existed; the page says "this link no longer works" and means it.
 */
export function getSharedReport(
  token: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ success?: boolean; data?: { report: SharedReport; expiresAt: string } }> {
  return anonymousRequest(`/api/public/reports/${encodeURIComponent(token)}`, { signal: opts.signal });
}

/**
 * The URL a shared report's PDF is downloaded from.
 *
 * A URL rather than a fetch, and deliberately: this audience has no session, so there is
 * no header to attach and a plain link is strictly better than a blob. The browser's own
 * download UI handles a slow render and a cancel, nothing is buffered in the page, and a
 * 503 from an instance without a renderer is a page the reader can read rather than a
 * silent failure inside a component.
 *
 * The token is in the path, exactly as the read route has it, so nginx's
 * `^~ /api/public/reports/` block keeps it out of the access log by prefix.
 */
export function sharedReportPdfUrl(token: string): string {
  return `/api/public/reports/${encodeURIComponent(token)}/pdf`;
}
