// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import axios from 'axios';
import { ERROR_CODES } from './error-handler.js';
import { printDebug, printError, printSuccess } from './output-utils.js';
import { isProductionEnv } from './tls.js';

/**
 * Login / refresh / switch-org response — every platform auth endpoint returns
 * the session tokens under this envelope.
 */
export interface AuthResponse {
  success: boolean;
  data: {
    accessToken: string;
    refreshToken: string;
  };
}

/**
 * Guard the credential-transmitting commands (`login`, `create-pat`) against
 * disabling TLS verification in production. These POST plaintext passwords/JWTs,
 * so a MITM on a `prod + --no-verify-ssl` run would harvest them.
 *
 * Unlike {@link assertSslDisableAllowed} (which throws — for paths already inside
 * a try/catch), this prints and hard-exits, matching the pre-flight checks these
 * commands run before their try block. In non-production it is a no-op, so
 * `--no-verify-ssl` still works against self-signed dev platforms.
 */
export function assertCredentialTlsAllowed(verifySsl: boolean | undefined): void {
  if (verifySsl === false && isProductionEnv()) {
    printError('Refusing to disable TLS verification in production (NODE_ENV=production) — credentials must not be transmitted over an unverified connection. Use a valid certificate, or unset NODE_ENV for local/self-signed development.');
    process.exit(ERROR_CODES.AUTHENTICATION);
  }
}

/**
 * Resolve credentials from flags, falling back to the
 * PLATFORM_IDENTIFIER / PLATFORM_PASSWORD env vars (so the password need not
 * appear in shell history / `ps`).
 */
export function resolveCredentials(options: { identifier?: string; password?: string }): {
  identifier?: string;
  password?: string;
} {
  return {
    identifier: options.identifier || process.env.PLATFORM_IDENTIFIER,
    password: options.password || process.env.PLATFORM_PASSWORD,
  };
}

/**
 * Build the https agent used by the credential commands. `--verify-ssl`
 * defaults to on; only an explicit `--no-verify-ssl` relaxes it (and only
 * outside production, enforced by {@link assertCredentialTlsAllowed}).
 */
export function credentialHttpsAgent(verifySsl: boolean | undefined): https.Agent {
  return new https.Agent({ rejectUnauthorized: verifySsl ?? true });
}

/**
 * POST /api/auth/login and return the access token (or `undefined` if the
 * response carried none). Rate-limit accounting (record success/failure) and
 * the no-token exit are intentionally left to the caller so each command keeps
 * its exact lockout semantics.
 */
export async function postLogin(params: {
  url: string;
  identifier: string;
  password: string;
  httpsAgent: https.Agent;
  timeout: number;
}): Promise<string | undefined> {
  const loginUrl = `${params.url}/api/auth/login`;
  printDebug('POST', { url: loginUrl });
  const response = await axios.post<AuthResponse>(
    loginUrl,
    { identifier: params.identifier, password: params.password },
    { headers: { 'Content-Type': 'application/json' }, httpsAgent: params.httpsAgent, timeout: params.timeout },
  );
  return response.data?.data?.accessToken;
}

/**
 * POST /api/auth/switch-org with the current access token and return the new,
 * org-scoped access token. Prints a success line (unless `quiet`) and hard-exits
 * on a missing token — both credential commands treat a failed switch the same.
 */
export async function switchOrganization(params: {
  url: string;
  orgId: string;
  accessToken: string;
  httpsAgent: https.Agent;
  timeout: number;
  quiet: boolean;
}): Promise<string> {
  const switchUrl = `${params.url}/api/auth/switch-org`;
  printDebug('POST', { url: switchUrl });
  const response = await axios.post<AuthResponse>(
    switchUrl,
    { organizationId: params.orgId },
    {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${params.accessToken}` },
      httpsAgent: params.httpsAgent,
      timeout: params.timeout,
    },
  );
  const switched = response.data?.data?.accessToken;
  if (!switched) {
    printError('Organization switch failed: no access token in response');
    process.exit(ERROR_CODES.AUTHENTICATION);
  }
  if (!params.quiet) printSuccess(`Switched to organization ${params.orgId}`);
  return switched;
}
