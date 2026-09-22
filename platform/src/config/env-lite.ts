// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Environment settings for modules that must NOT load `config/index.ts`.
 *
 * The main config runs platform's boot-time guards at import (a missing
 * `MONGODB_URI` / `SECRET_ENCRYPTION_KEY` throws). The auth middleware and the
 * helpers it imports run on every route chain and in many test suites that
 * have no business booting those guards, so the handful of settings they need
 * live here instead: parsed through api-core's shared readers, with no other
 * dependency. Every value is read on access, so an operator's change (e.g. the
 * bootstrap email list) and a test's per-case stub both take effect without a
 * reload. Documented in docs/environment-variables.md with the rest.
 */

import { envBool, envInt, envStr } from '@pipeline-builder/api-core';

export const envLite = {
  /**
   * Path the refresh cookie is scoped to, as the BROWSER sees it. nginx strips
   * the `/api` prefix before proxying, so this is the public path.
   */
  get refreshCookiePath(): string {
    return envStr('AUTH_REFRESH_COOKIE_PATH', '/api/auth/refresh');
  },

  /**
   * `Secure` on the session cookies. Every shipped target terminates TLS in
   * front of the gateway and browsers treat `http://localhost` as a secure
   * context, so this stays on by default. `AUTH_COOKIE_SECURE=false` is for a
   * plain-http deployment on a non-localhost hostname, where the browser would
   * drop the cookie and no session could ever refresh.
   */
  get authCookieSecure(): boolean {
    return envBool('AUTH_COOKIE_SECURE', true);
  },

  /**
   * Refresh-token lifetime in seconds — the same variable (and default) as
   * `config.auth.refreshToken.expiresIn`, so the cookie's Max-Age never
   * disagrees with the token inside it.
   */
  get refreshTokenExpiresInSeconds(): number {
    return envInt('REFRESH_TOKEN_EXPIRES_IN', 2592000);
  },

  /** Per-org KMS data keys for secret encryption (opt-in). */
  get perOrgKmsEnabled(): boolean {
    return envBool('SECRET_ENCRYPTION_PER_ORG_KMS', false);
  },

  /** Postgres RLS context enforcement mode as configured (reported, not enforced, here). */
  get rlsContextMode(): string {
    return envStr('RLS_CONTEXT_MODE', 'warn').toLowerCase();
  },

  /**
   * Operator-authorized platform super-admin emails (`BOOTSTRAP_SUPERADMIN_EMAILS`,
   * comma-separated), normalized to lowercase. Unset in customer/SaaS
   * environments, where the set is empty and nobody is authorized.
   */
  get bootstrapSuperAdminEmails(): Set<string> {
    return new Set(
      envStr('BOOTSTRAP_SUPERADMIN_EMAILS', '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    );
  },

  /** `BOOTSTRAP_SETUP_WINDOW_MS`, or undefined when unset / not a positive integer. */
  get bootstrapSetupWindowMs(): number | undefined {
    const ms = envInt('BOOTSTRAP_SETUP_WINDOW_MS', 0);
    return ms > 0 ? ms : undefined;
  },
};
