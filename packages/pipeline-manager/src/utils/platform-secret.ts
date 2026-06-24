// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared platform-token → secret-name resolution, used by both `store-token`
 * (which WRITES the JWT to Secrets Manager) and `setup-events` (which deploys the
 * Lambda that READS it). Both must agree on the same secret path, so the logic
 * lives here once: derive `{SECRETS_PATH_PREFIX}/{orgId}/platform` from the JWT's
 * organizationId, logging in first if needed to obtain the token.
 */

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import axios from 'axios';
import { decodeTokenPayload } from './auth-guard.js';
import { getConfigWithOptions } from './config-loader.js';
import { printInfo, printSection, printSuccess, printWarning } from './output-utils.js';

/** Login/secret options shared across the platform-secret helpers. */
export interface PlatformSecretOptions {
  readonly email?: string;
  readonly password?: string;
  readonly verifySsl?: boolean;
}

/**
 * Derive the platform secret path from a JWT's organizationId.
 * Pattern: `{SECRETS_PATH_PREFIX}/{orgId}/platform`.
 * @throws if the token carries no organizationId (caller should fall back to PLATFORM_SECRET_NAME).
 */
export function resolveSecretName(token: string): string {
  const payload = decodeTokenPayload(token);
  const orgId = payload?.organizationId;
  if (!orgId) {
    throw new Error('Token does not contain organizationId — cannot derive secret name. Set PLATFORM_SECRET_NAME to specify it explicitly.');
  }
  return `${CoreConstants.SECRETS_PATH_PREFIX}/${orgId}/platform`;
}

/**
 * Ensure `process.env.PLATFORM_TOKEN` is set. No-op if it already is. Otherwise,
 * if login creds are available (`--email/--password` or `PLATFORM_IDENTIFIER`/
 * `PLATFORM_PASSWORD` env — the env path lets `provision` pass creds without
 * putting the password on the command line), log in and set PLATFORM_TOKEN.
 */
export async function ensurePlatformToken(options: PlatformSecretOptions): Promise<void> {
  if (process.env.PLATFORM_TOKEN) return;
  const loginEmail = options.email || process.env.PLATFORM_IDENTIFIER;
  const loginPassword = options.password || process.env.PLATFORM_PASSWORD;
  if (!loginEmail || !loginPassword) return;

  if (options.password) {
    printWarning('Passing --password on the command line can expose it via shell history; prefer the PLATFORM_PASSWORD env var.');
  }

  printSection('Login');
  printInfo('Authenticating with email/password...');
  const config = getConfigWithOptions(options);
  const loginResponse = await axios.post(
    `${config.api.baseUrl}/api/auth/login`,
    { email: loginEmail, password: loginPassword },
    {
      httpsAgent: config.api.rejectUnauthorized === false
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
      + '(--email/--password or PLATFORM_IDENTIFIER/PLATFORM_PASSWORD).',
    );
  }
  return resolveSecretName(process.env.PLATFORM_TOKEN);
}
