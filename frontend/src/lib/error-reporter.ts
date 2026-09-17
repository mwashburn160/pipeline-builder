// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight, dependency-free client-side error reporting.
 *
 * Reports go to the SAME-ORIGIN relay at {@link CLIENT_ERROR_PATH}, which
 * forwards them to the collector named by the runtime `ERROR_REPORT_URL` env on
 * the frontend server (see `error-report-relay.ts`). Same-origin keeps the CSP's
 * `connect-src 'self'` intact, and a runtime env works with the single prebuilt
 * image shared by every deployment. When no collector is configured the relay
 * answers `X-Error-Reporting: off` and this module stops sending for the rest of
 * the session — so an unconfigured deployment costs at most one request. In
 * development every error is also logged to the console.
 */

import { redactString } from './redact';
import { CLIENT_ERROR_PATH, REPORTING_STATE_HEADER } from './error-report-relay';

/**
 * Drop everything after the path: the query string and hash are where the
 * app's single-use secrets live — `/invite/accept?token=…`,
 * `/auth/verify-email?token=…`, `/auth/callback/[provider]?code=…&state=…`.
 * Reporting `window.location.href` verbatim handed a live invite token or OAuth
 * authorization code to whatever collector `ERROR_REPORT_URL` points at. The path alone is what makes a report actionable anyway.
 */
function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw, window.location.origin);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    // Not parseable — drop it rather than risk forwarding an opaque string
    // that might still carry a token.
    return '';
  }
}

export interface ClientErrorContext {
  source: 'react' | 'window.onerror' | 'unhandledrejection';
  componentStack?: string;
  url?: string;
}

let initialized = false;
/** Latched once the relay reports no collector is configured (per page session). */
let reportingOff = false;

/** Report a single client-side error. Never throws. */
export function reportClientError(error: Error, context: ClientErrorContext): void {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(`[client-error:${context.source}]`, error, context);
  }
  if (reportingOff || typeof window === 'undefined' || typeof fetch !== 'function') return;

  try {
    // Everything free-form goes through `redactString` on the way out — the
    // same scrub the render surfaces apply. A server error message quoted into
    // `error.message` can carry an AWS account id, and this is the one place in
    // the app that sends text OFF-BOX.
    const payload = JSON.stringify({
      name: error.name,
      message: redactString(error.message ?? ''),
      stack: error.stack ? redactString(error.stack) : undefined,
      source: context.source,
      componentStack: context.componentStack ? redactString(context.componentStack) : undefined,
      url: sanitizeUrl(context.url ?? window.location.href),
      userAgent: navigator.userAgent,
      ts: new Date().toISOString(),
    });
    // `keepalive` lets the request outlive a page unload (e.g. an error that
    // navigates away), like sendBeacon — but unlike a beacon it exposes the
    // response, which carries the relay's on/off state.
    void fetch(CLIENT_ERROR_PATH, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      keepalive: true,
    }).then((res) => {
      if (res.headers.get(REPORTING_STATE_HEADER) === 'off') reportingOff = true;
    }).catch(() => { /* swallow — reporting must never surface to the user */ });
  } catch {
    // Error reporting must never throw.
  }
}

/**
 * Install global handlers for faults the React error boundary can't catch:
 * async errors, event-handler throws, and unhandled promise rejections. Call
 * once at app startup. Idempotent and SSR-safe.
 */
export function initClientErrorReporting(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  window.addEventListener('error', (e: ErrorEvent) => {
    reportClientError(e.error instanceof Error ? e.error : new Error(e.message), { source: 'window.onerror' });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportClientError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)), { source: 'unhandledrejection' });
  });
}
