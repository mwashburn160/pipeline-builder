// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a sign-out in progress is taking this tab.
 *
 * A sign-out that says why (`/?reason=idle&minutes=N`, `/?reason=session-expired`)
 * races the guarded page's own bounce: `useAuthGuard` sees `user` clear and
 * sends the tab to sign-in as well, and Next.js lets the LATER navigation win.
 * So the sign-out records its destination here first, and the guard routes
 * there instead of to a bare `/`. The record is spent once used: the sign-in
 * page clears it on arrival.
 *
 * Held in memory and in tab-scoped `sessionStorage` (a reload in the middle
 * still lands on the reason). Storage can throw or be absent; memory alone is
 * then enough for the in-page race.
 */

const PENDING_SIGN_OUT_KEY = 'pb.pendingSignOut';

let pending: string | null = null;

/** Only the sign-in page itself, with a plain query, is a sign-out destination
 *  (storage is page-reachable input, so it is checked on read too). */
function sanitize(raw: unknown): string | null {
  return typeof raw === 'string' && /^\/(\?[A-Za-z0-9=&_.-]{0,200})?$/.test(raw) ? raw : null;
}

/** Record where the sign-out under way is taking the tab. */
export function setPendingSignOut(href: string): void {
  const safe = sanitize(href);
  pending = safe;
  try {
    if (safe) window.sessionStorage.setItem(PENDING_SIGN_OUT_KEY, safe);
    else window.sessionStorage.removeItem(PENDING_SIGN_OUT_KEY);
  } catch { /* no storage — memory covers the in-page race */ }
}

/**
 * Where a sign-out under way is taking the tab, or `null`. Read, not spent: a
 * dashboard page holds many `useAuthGuard` callers, and every one of them must
 * reach the same answer — the first to read must not leave the rest a bare
 * `/`. The sign-in page spends it on arrival ({@link clearPendingSignOut}).
 */
export function pendingSignOut(): string | null {
  if (pending) return pending;
  try {
    return sanitize(window.sessionStorage.getItem(PENDING_SIGN_OUT_KEY));
  } catch {
    return null;
  }
}

/**
 * Drop the record: the sign-in page it pointed at has been reached (the
 * landing page calls this on mount — by then the guarded page that could
 * race is gone), so nothing stale is left for a later, plain bounce.
 */
export function clearPendingSignOut(): void {
  pending = null;
  try { window.sessionStorage.removeItem(PENDING_SIGN_OUT_KEY); } catch { /* no storage */ }
}
