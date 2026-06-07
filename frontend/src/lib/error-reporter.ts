// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lightweight, dependency-free client-side error reporting.
 *
 * The sink is configured via `NEXT_PUBLIC_ERROR_REPORT_URL` (a collector
 * endpoint). When unset, reporting is a no-op in production and logs to the
 * console in development. The point is a SINGLE wired integration point instead
 * of scattered `console.error` calls — turning on monitoring is one env var, no
 * code change and no vendor lock-in (point it at a backend route, Sentry tunnel,
 * or any HTTP collector).
 */

export interface ClientErrorContext {
  source: 'react' | 'window.onerror' | 'unhandledrejection';
  componentStack?: string;
  url?: string;
}

const ENDPOINT = process.env.NEXT_PUBLIC_ERROR_REPORT_URL;
let initialized = false;

/** Report a single client-side error. Never throws. */
export function reportClientError(error: Error, context: ClientErrorContext): void {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(`[client-error:${context.source}]`, error, context);
  }
  if (!ENDPOINT || typeof window === 'undefined') return;

  try {
    const payload = JSON.stringify({
      name: error.name,
      message: error.message,
      stack: error.stack,
      source: context.source,
      componentStack: context.componentStack,
      url: context.url ?? window.location.href,
      userAgent: navigator.userAgent,
      ts: new Date().toISOString(),
    });
    // `sendBeacon` is non-blocking and survives a page unload (e.g. an error that
    // navigates away); fall back to a keepalive fetch where it's unavailable.
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    } else {
      void fetch(ENDPOINT, {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
      }).catch(() => { /* swallow — reporting must never surface to the user */ });
    }
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
