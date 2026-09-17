// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side half of client error reporting: relays a browser error report to
 * the collector named by the RUNTIME env `ERROR_REPORT_URL`.
 *
 * Why a same-origin relay instead of the browser posting to the collector:
 *  - The frontend ships as ONE prebuilt image across every deployment, so a
 *    `NEXT_PUBLIC_*` URL (inlined at `next build`) could never be configured
 *    per deployment — reporting was dead everywhere.
 *  - The CSP (next.config.js AND each nginx config) pins `connect-src 'self'`,
 *    so a browser beacon to a cross-origin collector is blocked anyway. The
 *    relay keeps that CSP intact.
 *
 * When `ERROR_REPORT_URL` is unset the relay drops the report and tells the
 * client (via {@link REPORTING_STATE_HEADER}) to stop sending for the session.
 */

/** Public, same-origin path the browser posts to (rewritten to the API route). */
export const CLIENT_ERROR_PATH = '/client-errors';

/** Response header carrying whether a collector is configured: `on` | `off`. */
export const REPORTING_STATE_HEADER = 'X-Error-Reporting';

/** Per-field caps — a report is a diagnostic, not a transport for bulk text. */
const FIELD_LIMITS = {
  name: 200,
  message: 2_000,
  stack: 16_000,
  source: 40,
  componentStack: 16_000,
  url: 2_000,
  userAgent: 500,
  ts: 40,
} as const;

type ReportField = keyof typeof FIELD_LIMITS;

/** The report shape forwarded to the collector (unknown keys are dropped). */
export type ClientErrorReport = Partial<Record<ReportField, string>>;

/**
 * Keep only the known string fields, each truncated to its cap. Returns null
 * when the body isn't a report at all (no message and no name).
 */
export function sanitizeReport(body: unknown): ClientErrorReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  const out: ClientErrorReport = {};
  for (const key of Object.keys(FIELD_LIMITS) as ReportField[]) {
    const v = src[key];
    if (typeof v === 'string') out[key] = v.slice(0, FIELD_LIMITS[key]);
  }
  return out.message || out.name ? out : null;
}

/**
 * Fixed-window, process-wide cap on relayed reports. The endpoint is
 * unauthenticated (errors happen on the login page too), so without a cap it
 * would be an open amplifier into the collector. Deliberately NOT keyed on a
 * client IP — forwarded-for headers are client-controlled.
 */
export function createRelayLimiter(maxPerWindow = 120, windowMs = 60_000, now: () => number = Date.now) {
  let windowStart = now();
  let count = 0;
  return (): boolean => {
    const t = now();
    if (t - windowStart >= windowMs) { windowStart = t; count = 0; }
    if (count >= maxPerWindow) return false;
    count += 1;
    return true;
  };
}

export type RelayOutcome = 'disabled' | 'invalid' | 'rate_limited' | 'forwarded' | 'failed';

/**
 * Forward one report. Never throws — a broken collector must not turn into an
 * error on the page that is already reporting an error.
 */
export async function relayClientError(
  body: unknown,
  opts: {
    endpoint: string | undefined;
    allow: () => boolean;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<RelayOutcome> {
  if (!opts.endpoint) return 'disabled';
  const report = sanitizeReport(body);
  if (!report) return 'invalid';
  if (!opts.allow()) return 'rate_limited';
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
    });
    return res.ok ? 'forwarded' : 'failed';
  } catch {
    return 'failed';
  }
}
