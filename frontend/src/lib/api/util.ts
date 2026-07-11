// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Use relative URL in browser (requests go through nginx), absolute URL for SSR
export const API_URL = typeof window !== 'undefined' ? '' : (process.env.PLATFORM_BASE_URL || 'https://localhost:8443');

/** Build a query string from optional params, filtering out undefined/empty values. */
export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)]);
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return atob(base64);
}

/** True iff the backend error code indicates the request needs a fresh step-up. */
export function isStepUpErrorCode(code?: string): boolean {
  return code === 'STEP_UP_REQUIRED'
    || code === 'STEP_UP_INVALID'
    || code === 'STEP_UP_MISMATCH'
    || code === 'STEP_UP_REPLAY';
}
