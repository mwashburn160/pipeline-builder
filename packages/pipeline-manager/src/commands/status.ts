// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isOpaqueApiKey } from '@pipeline-builder/api-core';
import axios from 'axios';
import { Command } from 'commander';
import { ENV_VARS, TIMEOUTS } from '../config/cli.constants.js';
import { decodeTokenPayload } from '../utils/auth-guard.js';
import { checkCdkAvailable } from '../utils/cdk-utils.js';
import { printCommandHeader } from '../utils/command-utils.js';
import { getApiConfig } from '../utils/config-loader.js';
import { isSessionUsable, loadSession } from '../utils/credential-store.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printKeyValue, printSection } from '../utils/output-utils.js';
import { requestCorrelationHeaders } from '../utils/request-context.js';
import { httpsAgentForUrl, platformHttpsAgent } from '../utils/tls.js';

/** Which credential later commands would use, in `resolveToken`'s order. */
function credentialSource(baseUrl: string): { label: string; token?: string; expiresAt?: number } {
  const envToken = process.env[ENV_VARS.PLATFORM_TOKEN];
  if (envToken) return { label: 'PLATFORM_TOKEN (environment)', token: envToken };
  const stored = loadSession(baseUrl);
  if (!stored) return { label: 'none — run "pipeline-manager auth login"' };
  const { accessToken, refreshToken, expiresAt } = stored;
  if (isSessionUsable(stored)) return { label: 'stored session ("auth login")', token: accessToken, expiresAt };
  return refreshToken
    ? { label: 'stored session ("auth login", expired — renewed on the next command)', expiresAt }
    : { label: 'stored session ("auth login", expired — run "auth login" again)', expiresAt };
}

/**
 * Registers the `status` command with the CLI program.
 *
 * Reports the CLI's setup, not a deployment: which platform it talks to (the
 * same base-URL layers every command resolves), which credential it would use
 * and when that expires, CDK availability, whether the platform answers
 * `/health`, and — with a usable credential — whether the platform ACCEPTS it,
 * and as whom (`GET /api/user/profile`).
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function status(program: Command): void {
  program
    .command('status')
    .description('Show the CLI setup: platform, credential, sign-in check, CDK and platform reachability')
    .option('--json', 'Output result as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Status', undefined, { quiet: options.json });

      try {
        const results: Record<string, string> = {};
        const apiConfig = getApiConfig();
        const baseUrl = apiConfig.api.baseUrl;
        results.Platform = baseUrl;

        const credential = credentialSource(baseUrl);
        results.Credential = credential.label;
        results.PLATFORM_SECRET_NAME = process.env.PLATFORM_SECRET_NAME || 'not set';
        results['CDK Available'] = checkCdkAvailable() ? 'yes' : 'no';

        // The credential-free reachability probe skips cert verification for
        // local/self-signed hosts only; real domains are verified.
        try {
          await axios.get(`${baseUrl}/health`, { timeout: TIMEOUTS.HEALTH_CHECK, httpsAgent: httpsAgentForUrl(baseUrl) });
          results['Platform Health'] = 'reachable';
        } catch {
          results['Platform Health'] = 'unreachable';
        }

        // Expiry: a stored session records it; a JWT carries it; an ACCESS KEY
        // carries no claims at all — its expiry lives on its record and is shown
        // on the keys page.
        const token = credential.token;
        if (credential.expiresAt !== undefined) {
          results['Token Expires'] = new Date(credential.expiresAt).toISOString();
          results['Token Expired'] = credential.expiresAt < Date.now() ? 'yes' : 'no';
        } else if (token) {
          const payload = decodeTokenPayload(token);
          if (isOpaqueApiKey(token)) {
            results['Token Expires'] = 'n/a (access key — see Dashboard → API Tokens)';
          } else if (!payload) {
            results['Token Expires'] = 'unable to decode';
          } else if (typeof payload.exp === 'number') {
            const expiresAt = new Date(payload.exp * 1000);
            results['Token Expires'] = expiresAt.toISOString();
            results['Token Expired'] = expiresAt.getTime() < Date.now() ? 'yes' : 'no';
          }
        }

        // The check that matters: does the platform accept the credential?
        // This call carries the bearer, so it uses the SAME TLS policy as every
        // authenticated command (PLATFORM_CA_BUNDLE, PLATFORM_TLS_VERIFY, refused
        // in production) — never the local-host relaxation above, which would
        // send the credential over an unverified connection.
        if (token) {
          const httpsAgent = platformHttpsAgent(apiConfig.api.rejectUnauthorized);
          try {
            const res = await axios.get<{ data?: { user?: { email?: string; activeOrgName?: string | null; organizationId?: string } } }>(
              `${baseUrl}/api/user/profile`,
              { timeout: TIMEOUTS.HEALTH_CHECK, httpsAgent, headers: { Authorization: `Bearer ${token}`, ...requestCorrelationHeaders() } },
            );
            const user = res.data?.data?.user;
            results['Signed In'] = 'yes';
            if (user?.email) results['Signed In As'] = user.email;
            const org = user?.activeOrgName ?? user?.organizationId;
            if (org) results.Organization = org;
          } catch (error) {
            const code = axios.isAxiosError(error) ? error.response?.status : undefined;
            results['Signed In'] = code === 401 || code === 403
              ? `no — the platform rejected the credential (${code})`
              : 'unknown — the platform could not be reached';
          }
        } else {
          results['Signed In'] = credential.expiresAt !== undefined ? 'session expired' : 'no';
        }

        if (options.json) {
          console.log(JSON.stringify({ success: true, executionId, ...results }, null, 2));
        } else {
          printSection('CLI Status');
          printKeyValue(results);
        }

      } catch (error) {
        handleError(error, ERROR_CODES.GENERAL, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'status', executionId },
        });
      }
    });
}
