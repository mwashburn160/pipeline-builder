// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared platform-token → secret-name resolution, used by both `store-token`
 * (which WRITES the JWT to Secrets Manager) and `setup-events` (which deploys the
 * Lambda that READS it). Both must agree on the same secret path, so the logic
 * lives here once: derive `{SECRETS_PATH_PREFIX}/{orgId}/platform` from the JWT's
 * organizationId, logging in first if needed to obtain the token.
 */

import { isOpaqueApiKey } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import axios from 'axios';
import { decodeTokenPayload } from './auth-guard.js';
import { getApiConfig } from './config-loader.js';
import { printInfo, printSection, printSuccess, printWarning } from './output-utils.js';
import { assertSslDisableAllowed } from './tls.js';

/** Login/secret options shared across the platform-secret helpers. */
export interface PlatformSecretOptions {
  /**
   * Login identifier (username OR email) for the NON-INTERACTIVE machine login
   * below. This is the only password path left in the CLI: `auth login` and
   * `auth pat` sign in through the browser (device authorization), but
   * `store-token` / `setup-events` run on hosts with nobody present to approve a
   * code, and what they mint is a machine credential, not a person's session.
   */
  readonly identifier?: string;
  readonly password?: string;
  readonly verifySsl?: boolean;
}

/**
 * The Secrets Manager path a stored machine credential lives at:
 * `{SECRETS_PATH_PREFIX}/{orgId}/{leaf}`.
 *
 * `leaf` is `platform` for the org's full-privilege automation credential, and
 * the scope's slug (`reporting-ingest`, `registry-push`) for a least-privilege
 * one — so a scoped credential can never clobber the platform one, and the
 * events Lambda's secret is a different object from CodeBuild's.
 */
export function secretNameForOrg(orgId: string, leaf: string = 'platform'): string {
  return `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/${leaf}`;
}

/** A capability scope as a secret-path leaf: `reporting:ingest` → `reporting-ingest`. */
export function scopeSecretLeaf(scope: string): string {
  return scope.replace(/[^a-z0-9]+/gi, '-');
}

/**
 * Derive the platform secret path from a JWT's organizationId.
 * Pattern: `{SECRETS_PATH_PREFIX}/{orgId}/platform`.
 * @throws if the token carries no organizationId (caller should fall back to PLATFORM_SECRET_NAME).
 */
export function resolveSecretName(token: string): string {
  // An ACCESS KEY (`pb_pat_…`) is opaque — it carries no org claim to read, by
  // design. Say so instead of the generic decode failure, since exporting a key
  // as PLATFORM_TOKEN is now the normal way to authenticate the CLI.
  if (isOpaqueApiKey(token)) {
    throw new Error(
      'PLATFORM_TOKEN is an opaque access key, which carries no organizationId — set PLATFORM_SECRET_NAME to name the secret explicitly.',
    );
  }
  const payload = decodeTokenPayload(token);
  const orgId = payload?.organizationId;
  if (!orgId) {
    throw new Error('Token does not contain organizationId — cannot derive secret name. Set PLATFORM_SECRET_NAME to specify it explicitly.');
  }
  return secretNameForOrg(orgId);
}

/**
 * Ensure `process.env.PLATFORM_TOKEN` is set. No-op if it already is. Otherwise,
 * if login creds are available (`--identifier/--password` or `PLATFORM_IDENTIFIER`/
 * `PLATFORM_PASSWORD` env — the env path lets `provision` pass creds without
 * putting the password on the command line), log in and set PLATFORM_TOKEN.
 */
export async function ensurePlatformToken(options: PlatformSecretOptions): Promise<void> {
  if (process.env.PLATFORM_TOKEN) return;
  const loginIdentifier = options.identifier || process.env.PLATFORM_IDENTIFIER;
  const loginPassword = options.password || process.env.PLATFORM_PASSWORD;
  if (!loginIdentifier || !loginPassword) return;

  if (options.password) {
    printWarning('Passing --password on the command line can expose it via shell history; prefer the PLATFORM_PASSWORD env var.');
  }

  printSection('Login');
  printInfo('Authenticating with identifier/password...');
  // Resolve the base URL WITHOUT demanding a token — this login step runs
  // pre-auth (no PLATFORM_TOKEN yet), so `getConfig()` would throw here. The
  // token-optional loader still honors config files + PLATFORM_BASE_URL/TLS env.
  const apiConfig = getApiConfig();
  // SECURITY: this inline login POSTs the password. Refuse to disable cert
  // verification in production (mirrors config-loader / login) so a MITM can't
  // harvest it; honored in non-production for self-signed dev platforms.
  if (options.verifySsl === false) {
    assertSslDisableAllowed('inline login');
  }
  const rejectUnauthorized = options.verifySsl === false ? false : apiConfig.api.rejectUnauthorized;
  const loginResponse = await axios.post(
    `${apiConfig.api.baseUrl}/api/auth/login`,
    // The server's loginSchema requires `identifier` (email OR username), not
    // `email` — sending `email` fails zod validation with a 400.
    { identifier: loginIdentifier, password: loginPassword },
    {
      httpsAgent: rejectUnauthorized === false
        ? new (await import('https')).Agent({ rejectUnauthorized: false })
        : undefined,
    },
  );
  const loginData = loginResponse.data?.data ?? loginResponse.data;
  const loginToken = loginData?.accessToken;
  if (!loginToken || typeof loginToken !== 'string') {
    throw new Error('Login failed — no access token in response');
  }
  process.env.PLATFORM_TOKEN = loginToken;
  printSuccess('Login successful');
}

/**
 * Resolve the platform secret name: an explicit `PLATFORM_SECRET_NAME` env wins;
 * otherwise log in if needed and derive it from the platform token's org — the
 * same token `init-platform.sh` (register) mints, so writer and reader agree.
 */
export async function resolvePlatformSecretName(options: PlatformSecretOptions): Promise<string> {
  const explicit = process.env.PLATFORM_SECRET_NAME;
  if (explicit) return explicit;
  await ensurePlatformToken(options);
  if (!process.env.PLATFORM_TOKEN) {
    throw new Error(
      'Cannot derive the platform secret name: no PLATFORM_TOKEN and no login creds. '
      + 'Set PLATFORM_SECRET_NAME, or provide login creds '
      + '(--identifier/--password or PLATFORM_IDENTIFIER/PLATFORM_PASSWORD).',
    );
  }
  return resolveSecretName(process.env.PLATFORM_TOKEN);
}
