// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage } from '@pipeline-builder/api-core';
import axios from 'axios';
import { Command } from 'commander';
import { TIMEOUTS } from '../config/cli.constants.js';
import { assertCredentialTlsAllowed } from '../utils/auth-utils.js';
import { printCommandHeader, refreshStoredSession, withSslOptions } from '../utils/command-utils.js';
import { getApiConfig } from '../utils/config-loader.js';
import { clearSession, isSessionUsable, loadSession } from '../utils/credential-store.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printSuccess, printWarning } from '../utils/output-utils.js';
import { requestCorrelationHeaders } from '../utils/request-context.js';
import { platformHttpsAgent } from '../utils/tls.js';

/**
 * Registers the `logout` command with the CLI program.
 *
 * Signs this device out of a platform: revokes the stored session's refresh
 * slot on the platform (`POST /api/auth/logout`) and deletes it from the
 * credential store. The platform call is best effort — the local copy is always
 * removed, and when the platform could not be told the command says so, since
 * the refresh token then stays valid until it is revoked from the web UI.
 *
 * An expired access token is renewed first (logout needs a valid one), so a
 * device idle for days can still sign itself out properly.
 *
 * `PLATFORM_TOKEN` is not touched: it is the caller's own environment variable,
 * and an access key is revoked from the keys page, not by signing out.
 *
 * @example
 * ```bash
 * pipeline-manager auth logout
 * pipeline-manager auth logout --url https://platform.example.com
 * ```
 */
export function logout(program: Command): void {
  withSslOptions(program
    .command('logout')
    .description('Sign this device out: revoke the stored session on the platform and delete it locally')
    .option('--url <url>', 'Platform base URL (default: PLATFORM_BASE_URL, else the platform you last signed in to, else config.yml)'))
    .action(async (options) => {
      // The request carries a bearer credential (and a renewal spends the
      // refresh token), so the same TLS refusal as login applies.
      assertCredentialTlsAllowed(options.verifySsl);

      const url: string = options.url ?? getApiConfig().api.baseUrl;
      const executionId = printCommandHeader('Logout', 'Sign out of the platform');

      try {
        const stored = loadSession(url);
        if (!stored) {
          printInfo('No stored session for this platform — nothing to sign out', { platform: url });
          return;
        }

        // 'revoked' — the platform ended it now; 'dead' — the platform had already
        // refused it (renewal rejected, or no refresh token left to renew with);
        // 'unknown' — the platform could not be reached.
        let outcome: 'revoked' | 'dead' | 'unknown' = 'unknown';
        try {
          const accessToken = isSessionUsable(stored)
            ? stored.accessToken
            : await refreshStoredSession(url, stored);
          if (accessToken) {
            await axios.post(`${url}/api/auth/logout`, {}, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                // The CSRF gate on /auth/logout (see platform requireClientType).
                'X-Pb-Client': 'cli',
                ...requestCorrelationHeaders(),
              },
              httpsAgent: platformHttpsAgent(options.verifySsl),
              timeout: TIMEOUTS.HTTP_REQUEST,
            });
            outcome = 'revoked';
          } else {
            outcome = 'dead';
          }
        } catch (error) {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          printWarning('Could not revoke the session on the platform', {
            ...(status !== undefined ? { status } : {}),
            error: errorMessage(error),
          });
        }

        clearSession(url);

        if (outcome === 'revoked') {
          printSuccess('Signed out — the session is revoked and removed from this device');
        } else if (outcome === 'dead') {
          printSuccess('Removed the stored session from this device (the platform had already ended it)');
        } else {
          printSuccess('Removed the stored session from this device');
          printWarning('The platform was not told: revoke this device under Settings → Sessions and devices');
        }
      } catch (error) {
        handleError(error, ERROR_CODES.AUTHENTICATION, {
          exit: true,
          context: { command: 'logout', executionId, url },
        });
      }
    });
}
