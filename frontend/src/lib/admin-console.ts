// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator consoles (pgAdmin, mongo-express, Grafana, Kiali) behind the AWS
 * gateway, and the cookie that lets a platform administrator through it.
 *
 * nginx fronts each console with an `auth_request` to platform's
 * `GET /admin/console-check` (sysadmin + AAL2), carrying the bearer from the
 * `pb_admin_console` cookie (deploy/aws/*\/nginx/admin-uis.conf) and stripping it
 * before proxying, so no console ever sees a platform credential.
 *
 * The cookie holds the CURRENT access token, so it lives exactly as long as that
 * token: `Max-Age` never outlasts the token's `exp`, it is re-written when the
 * token rotates while set (refresh, a sibling tab's handoff) and removed when
 * the session ends or changes org. It is set only when a sysadmin opens a
 * console — nobody else ever carries it.
 */

import { isAwsTarget } from '@/lib/deploy-target';
import { decodeJwt } from '@/lib/jwt';

export const ADMIN_CONSOLE_COOKIE = 'pb_admin_console';

export interface AdminConsole {
  id: 'grafana' | 'kiali' | 'pgadmin' | 'mongo-express';
  label: string;
  /** Same-origin path the gateway serves it under. */
  path: string;
  description: string;
}

export const ADMIN_CONSOLES: readonly AdminConsole[] = [
  { id: 'grafana', label: 'Grafana', path: '/grafana/', description: 'Dashboards over every tenant’s metrics and logs.' },
  { id: 'kiali', label: 'Kiali', path: '/kiali/', description: 'The service mesh: traffic, mTLS and routing.' },
  { id: 'pgadmin', label: 'pgAdmin', path: '/pgadmin/', description: 'The PostgreSQL database, directly.' },
  { id: 'mongo-express', label: 'mongo-express', path: '/mongo-express/', description: 'The MongoDB database, directly.' },
];

/** The deploy targets whose gateway serves the consoles (the AWS nginx). */
export function adminConsolesAvailable(deployTarget: string): boolean {
  return isAwsTarget(deployTarget);
}

/** Seconds until the token expires (0 when it is expired or unreadable). */
export function tokenSecondsLeft(token: string, nowMs = Date.now()): number {
  const exp = decodeJwt(token)?.payload?.exp;
  if (typeof exp !== 'number') return 0;
  return Math.max(0, Math.floor(exp - nowMs / 1000));
}

/**
 * Write the console cookie for `token`. Returns false (and clears any old
 * cookie) when the token has no time left — a cookie that outlives its token
 * would only make the gateway answer 401.
 */
export function setAdminConsoleCookie(token: string, nowMs = Date.now()): boolean {
  const maxAge = tokenSecondsLeft(token, nowMs);
  if (maxAge <= 0) {
    clearAdminConsoleCookie();
    return false;
  }
  document.cookie = `${ADMIN_CONSOLE_COOKIE}=${encodeURIComponent(token)}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  return true;
}

export function clearAdminConsoleCookie(): void {
  document.cookie = `${ADMIN_CONSOLE_COOKIE}=; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** The token the cookie currently carries, if any. */
function cookieToken(): string | null {
  const raw = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${ADMIN_CONSOLE_COOKIE}=`));
  const value = raw ? raw.slice(ADMIN_CONSOLE_COOKIE.length + 1) : '';
  if (!value) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

/**
 * Keep an already-set cookie in step with the access token (wired to
 * `api.onAccessTokenChange`): re-written for a rotated token of the SAME
 * administrator and org; dropped on sign-out, an org switch, an impersonation
 * token or anything that is no longer a platform administrator's. Nothing is
 * written unless a console was opened — no cookie, nothing to follow.
 */
export function syncAdminConsoleCookie(token: string | null): void {
  if (typeof document === 'undefined') return;
  const current = cookieToken();
  if (!current) return;
  if (!token) { clearAdminConsoleCookie(); return; }
  type Claims = { sub?: string; organizationId?: string; isSuperAdmin?: boolean; impersonationReadOnly?: boolean };
  const was = decodeJwt(current)?.payload as Claims | undefined;
  const now = decodeJwt(token)?.payload as Claims | undefined;
  const same = !!was && !!now && now.isSuperAdmin === true && !now.impersonationReadOnly
    && was.sub === now.sub && was.organizationId === now.organizationId;
  if (!same) { clearAdminConsoleCookie(); return; }
  setAdminConsoleCookie(token);
}
