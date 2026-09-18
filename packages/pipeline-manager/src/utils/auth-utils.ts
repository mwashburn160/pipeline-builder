// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import axios from 'axios';
import { ERROR_CODES } from './error-handler.js';
import { printDebug, printError, printSuccess } from './output-utils.js';
import { isProductionEnv } from './tls.js';

/**
 * Session payload as a NON-BROWSER client receives it: the refresh token rides
 * in the body (the browser's goes out as an HttpOnly cookie instead).
 */
export interface SessionTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Envelope every platform auth endpoint wraps its session tokens in. */
export interface AuthResponse {
  success: boolean;
  data: SessionTokens;
}

/**
 * Guard the credential-transmitting commands (`login`, `pat`) against disabling
 * TLS verification in production. The device flow keeps passwords off the wire
 * entirely, but the session tokens it returns are bearer credentials — a MITM on
 * a `prod + --no-verify-ssl` run would harvest them just the same.
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
 * Build the https agent used by the credential commands. `--verify-ssl`
 * defaults to on; only an explicit `--no-verify-ssl` relaxes it (and only
 * outside production, enforced by {@link assertCredentialTlsAllowed}).
 */
export function credentialHttpsAgent(verifySsl: boolean | undefined): https.Agent {
  return new https.Agent({ rejectUnauthorized: verifySsl ?? true });
}

/**
 * POST /api/auth/switch-org with the current access token and return the WHOLE
 * re-issued session.
 *
 * The switch re-issues the same session slot, which ROTATES its refresh token —
 * so a caller that keeps only the access token is left holding a dead refresh
 * token. Prints a success line (unless `quiet`) and hard-exits on a missing
 * token, since both credential commands treat a failed switch the same.
 */
export async function switchOrganization(params: {
  url: string;
  orgId: string;
  accessToken: string;
  httpsAgent: https.Agent;
  timeout: number;
  quiet: boolean;
}): Promise<SessionTokens> {
  const switchUrl = `${params.url}/api/auth/switch-org`;
  printDebug('POST', { url: switchUrl });
  const response = await axios.post<AuthResponse>(
    switchUrl,
    { organizationId: params.orgId },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.accessToken}`,
        // Declares the body transport for the re-issued refresh token.
        'X-Pb-Client': 'cli',
      },
      httpsAgent: params.httpsAgent,
      timeout: params.timeout,
    },
  );
  const switched = response.data?.data;
  if (!switched?.accessToken) {
    printError('Organization switch failed: no access token in response');
    process.exit(ERROR_CODES.AUTHENTICATION);
  }
  if (!params.quiet) printSuccess(`Switched to organization ${params.orgId}`);
  return switched;
}
