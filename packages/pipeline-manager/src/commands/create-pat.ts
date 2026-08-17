// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId, TIMEOUTS } from '../config/cli.constants.js';
import { assertCredentialTlsAllowed, credentialHttpsAgent, postLogin, resolveCredentials, switchOrganization } from '../utils/auth-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printDebug, printError, printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from '../utils/rate-limiter.js';

const { bold, cyan, green, magenta, yellow } = pico;

/** Step-up response — a short-lived (60s) JWT bound to the user's sub. */
interface StepUpResponse {
  success: boolean;
  data: { stepUpToken: string };
}

/** Create-PAT response — the raw token is returned exactly once. */
interface CreatePatResponse {
  success: boolean;
  data: {
    token: string;
    pat: { jti: string; name: string; expiresAt: string; scope?: string | null };
  };
}

const MAX_EXPIRES_DAYS = 365;

/**
 * Registers the `create-pat` command with the CLI program.
 *
 * Mints a named Personal Access Token — a durable, individually-revocable API
 * credential — for CI/automation. Unlike `login` (which returns a short-lived
 * session token), a PAT is the right long-lived credential for scripts.
 *
 * The platform gates PAT creation behind step-up re-authentication, so this
 * command chains three calls: login (→ access token), step-up with the same
 * password (→ step-up token), then POST /user/pats. The PAT binds to the user's
 * active org; pass `--org` to switch first (persists as the active org).
 *
 * The raw token is printed ONCE. `--quiet` prints only `export PLATFORM_TOKEN=…`
 * so it can be `eval`'d — the PAT is itself a valid Bearer credential.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * PLATFORM_PASSWORD=secret pipeline-manager auth pat --name ci-deploy -u ci@example.com
 * pipeline-manager auth pat --name ci --expires-days 30 -u ci@example.com -p secret
 * eval $(PLATFORM_PASSWORD=secret pipeline-manager auth pat --name ci -u ci@example.com --quiet)
 * ```
 */
export function createPat(program: Command): void {
  program
    .command('pat')
    .description('Create a named Personal Access Token (long-lived CLI/automation credential)')
    .requiredOption('--name <name>', 'Human-readable token name (e.g. ci-deploy)')
    .option('--expires-days <days>', `Token lifetime in days (1-${MAX_EXPIRES_DAYS})`, '90')
    .option('--scope <scope>', 'Optional token scope')
    .option('-u, --identifier <identifier>', 'Username or email')
    .option('-p, --password <password>', 'Password (prefer PLATFORM_PASSWORD env)')
    .option('--org <orgId>', 'Bind the token to a specific organization (switches active org)')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action(async (options) => {
      const executionId = generateExecutionId();

      // SECURITY: this POSTs a plaintext password (login + step-up). Never send it
      // over an unverified TLS connection in production — a MITM would harvest it.
      // Mirrors the guard in `login`. Non-production still honors --no-verify-ssl.
      assertCredentialTlsAllowed(options.verifySsl);

      // Credentials from flags OR PLATFORM_IDENTIFIER/PLATFORM_PASSWORD env (so the
      // password need not appear in shell history / `ps`).
      const { identifier, password } = resolveCredentials(options);
      const quiet = options.quiet ?? false;

      try {
        // Validate name.
        const name = typeof options.name === 'string' ? options.name.trim() : '';
        if (!name) {
          printError('Token name is required (--name)');
          process.exit(ERROR_CODES.VALIDATION);
        }
        if (name.length > 100) {
          printError('Token name must be 100 characters or fewer');
          process.exit(ERROR_CODES.VALIDATION);
        }

        // Validate expiry → seconds.
        const days = Math.floor(Number(options.expiresDays));
        if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRES_DAYS) {
          printError(`--expires-days must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
          process.exit(ERROR_CODES.VALIDATION);
        }
        const expiresIn = days * 86400;

        // Credentials required — step-up needs a password, so --refresh can't work here.
        if (!identifier || !password) {
          printError('create-pat requires --identifier and --password (or PLATFORM_IDENTIFIER/PLATFORM_PASSWORD env)');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        if (options.password) {
          printWarning('Passing --password on the command line can expose it via shell history; prefer the PLATFORM_PASSWORD env var.');
        }

        // Rate limiting — prevent brute force (keyed to identifier + url, like login).
        const rateLimitMsg = checkAuthRateLimit(identifier, options.url);
        if (rateLimitMsg) {
          printError(rateLimitMsg);
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        if (!quiet) {
          printSection('Create Personal Access Token');
          console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Create Personal Access Token'))}`);
          console.log('');
          printInfo('Authenticating', { identifier, url: options.url, verifySsl: options.verifySsl });
        }

        const httpsAgent = credentialHttpsAgent(options.verifySsl);
        const timeout = TIMEOUTS.HTTP_REQUEST;

        // 1) Login → session access token.
        let accessToken: string | undefined;
        try {
          accessToken = await postLogin({ url: options.url, identifier, password, httpsAgent, timeout });
        } catch (error) {
          recordAuthFailure(identifier, options.url);
          throw error;
        }
        if (!accessToken) {
          recordAuthFailure(identifier, options.url);
          printError('Login failed: no access token in response');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        recordAuthSuccess(identifier, options.url);

        // 2) Optionally bind to a specific org (persists as the active org, which the
        //    PAT inherits).
        if (options.org) {
          if (!quiet) printInfo('Switching to organization', { orgId: options.org });
          accessToken = await switchOrganization({
            url: options.url,
            orgId: options.org,
            accessToken,
            httpsAgent,
            timeout,
            quiet,
          });
        }

        // 3) Step-up — re-verify the password to unlock the gated create call.
        //    The returned token is short-lived (~60s), so we use it immediately.
        const stepUpUrl = `${options.url}/api/auth/step-up`;
        printDebug('POST', { url: stepUpUrl });
        const stepUpRes = await axios.post<StepUpResponse>(
          stepUpUrl,
          { password },
          { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }, httpsAgent, timeout },
        );
        const stepUpToken = stepUpRes.data?.data?.stepUpToken;
        if (!stepUpToken) {
          printError('Step-up verification failed: no step-up token in response');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        // 4) Create the PAT.
        const patUrl = `${options.url}/api/user/pats`;
        printDebug('POST', { url: patUrl });
        const patRes = await axios.post<CreatePatResponse>(
          patUrl,
          { name, expiresIn, ...(options.scope ? { scope: options.scope } : {}) },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`,
              'X-Step-Up-Token': stepUpToken,
            },
            httpsAgent,
            timeout,
          },
        );

        const token = patRes.data?.data?.token;
        const pat = patRes.data?.data?.pat;
        if (!token) {
          printError('Create token failed: no token in response');
          process.exit(ERROR_CODES.API_REQUEST);
        }

        // Quiet mode: emit only the export line (the PAT is a valid Bearer token).
        if (quiet) {
          console.log(`export PLATFORM_TOKEN=${token}`);
          return;
        }

        console.log('');
        printSuccess('Personal access token created');
        console.log('');
        printKeyValue({
          'Name': pat?.name ?? name,
          'Token ID (jti)': pat?.jti ?? '(unknown)',
          'Expires': pat?.expiresAt ?? `${days} day(s)`,
          ...(pat?.scope ? { Scope: pat.scope } : {}),
        });
        console.log('');
        console.log(yellow(bold('Copy your token now — it will not be shown again:')));
        console.log(green(token));
        console.log('');
        printInfo('Tip: use it as PLATFORM_TOKEN for subsequent commands:');
        console.log(green('  export PLATFORM_TOKEN=<token>'));
        console.log(green(`  # or:  eval $(pipeline-manager auth pat --name ${name} -u ${identifier} --quiet)`));
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;
          printError('Create token failed', {
            status: status ?? 'no response',
            ...(message ? { message } : {}),
          });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'create-pat', executionId, identifier: options.identifier, url: options.url },
        });
      }
    });
}
