// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { TIMEOUTS } from '../config/cli.constants.js';
import { assertCredentialTlsAllowed, credentialHttpsAgent, switchOrganization } from '../utils/auth-utils.js';
import { printCommandHeader, withSslOptions } from '../utils/command-utils.js';
import { DeviceAuthError, openInBrowser, pollForDeviceToken, requestDeviceCode } from '../utils/device-auth.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printDebug, printError, printInfo, printKeyValue, printSuccess } from '../utils/output-utils.js';

const { bold, cyan, dim, green, yellow } = pico;

/** Create-key response — the raw key is returned exactly once. */
interface CreateAccessKeyResponse {
  success: boolean;
  data: {
    /** The opaque key (`pb_pat_…`). Only its hash is stored server-side. */
    key: string;
    accessKey: { id: string; name: string; display: string; expiresAt: string; scope?: string | null };
  };
}

const MAX_EXPIRES_DAYS = 365;

/**
 * Registers the `pat` command with the CLI program.
 *
 * Mints a named ACCESS KEY (`pb_pat_…`) — a durable, individually-revocable API
 * credential — for CI/automation. Unlike a session, a key is the right
 * long-lived credential for scripts.
 *
 * The key is OPAQUE: it carries no claims, and each service trades it at
 * platform's /auth/token/exchange for a 5-minute token, so revoking it takes
 * effect everywhere within five minutes.
 *
 * Creating one is step-up gated server-side, yet the CLI holds no password: the
 * device flow asks for the step-up IN THE BROWSER, where the
 * account's real factors live, and the approved poll returns both the session
 * and a short-lived step-up token. The key binds to the user's active org; pass
 * `--org` to switch first (which persists as the active org).
 *
 * The raw key is printed ONCE — only its hash is stored, so it can never be read
 * back. `--quiet` prints only `export PLATFORM_TOKEN=…` so it can be `eval`'d;
 * the key is itself a valid Bearer credential.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * pipeline-manager auth pat --name ci-deploy
 * pipeline-manager auth pat --name ci --expires-days 30 --org <orgId>
 * eval $(pipeline-manager auth pat --name ci --quiet)
 * ```
 */
export function createPat(program: Command): void {
  withSslOptions(program
    .command('pat')
    .description('Create a named access key (long-lived, opaque CLI/automation credential)')
    .requiredOption('--name <name>', 'Human-readable key name (e.g. ci-deploy)')
    .option('--expires-days <days>', `Key lifetime in days (1-${MAX_EXPIRES_DAYS})`, '90')
    .option('--scope <scope>', 'Optional capability scope (least-privilege key)')
    .option('--org <orgId>', 'Bind the key to a specific organization (switches active org)')
    .option('--no-browser', 'Never open a browser — print the verification URL instead')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443'))
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action(async (options) => {
      // SECURITY: the poll returns a session AND a step-up token, and the response
      // below carries the raw key. None of that may cross an unverified connection
      // in production. Mirrors the guard in `login`.
      assertCredentialTlsAllowed(options.verifySsl);

      const quiet = options.quiet ?? false;
      const executionId = printCommandHeader('Create Access Key', 'Create Access Key', { quiet });

      try {
        // Validate name.
        const name = typeof options.name === 'string' ? options.name.trim() : '';
        if (!name) {
          printError('Key name is required (--name)');
          process.exit(ERROR_CODES.VALIDATION);
        }
        if (name.length > 100) {
          printError('Key name must be 100 characters or fewer');
          process.exit(ERROR_CODES.VALIDATION);
        }

        // Validate expiry → seconds.
        const days = Math.floor(Number(options.expiresDays));
        if (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRES_DAYS) {
          printError(`--expires-days must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
          process.exit(ERROR_CODES.VALIDATION);
        }
        const expiresIn = days * 86400;

        const httpsAgent = credentialHttpsAgent(options.verifySsl);
        const timeout = TIMEOUTS.HTTP_REQUEST;
        const transport = { url: options.url, httpsAgent, timeout };

        // 1) Device sign-in, asking for the step-up the create call needs.
        if (!quiet) printInfo('Starting browser sign-in', { url: options.url, verifySsl: options.verifySsl });
        const code = await requestDeviceCode(transport, { stepUp: true });
        const approvalUrl = code.verification_uri_complete || code.verification_uri;
        const opened = options.browser !== false && openInBrowser(approvalUrl);

        // The prompt goes to STDERR under `--quiet`: stdout is captured by
        // `eval $(…)`, so printing the code there would swallow the one thing
        // the user has to read before anything can proceed.
        const say = quiet ? console.error : console.log;
        say('');
        say(`  Your code:  ${bold(cyan(code.user_code))}`);
        say(`  Approve at: ${green(approvalUrl)}`);
        say('');
        say(dim(opened
          ? '  Opening your browser… approve the code there, then come back.'
          : '  Open that URL in a browser, check the code matches, and approve.'));
        if (!quiet) printInfo('Waiting for approval…');

        const session = await pollForDeviceToken(transport, code);
        let accessToken = session.access_token;
        const stepUpToken = session.step_up_token;
        if (!stepUpToken) {
          printError('The approval did not return a step-up confirmation — approve the code promptly and try again.');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        // 2) Optionally bind to a specific org (persists as the active org, which
        //    the key inherits). Rotates the session, but the step-up token is
        //    bound to the user, not the session, so it survives the switch.
        if (options.org) {
          if (!quiet) printInfo('Switching to organization', { orgId: options.org });
          accessToken = (await switchOrganization({
            url: options.url,
            orgId: options.org,
            accessToken,
            httpsAgent,
            timeout,
            quiet,
          })).accessToken;
        }

        // 3) Create the access key. The step-up token is short-lived (~60s) and
        //    single-use, so it is spent immediately.
        const keyUrl = `${options.url}/api/user/keys`;
        printDebug('POST', { url: keyUrl });
        const keyRes = await axios.post<CreateAccessKeyResponse>(
          keyUrl,
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

        const key = keyRes.data?.data?.key;
        const meta = keyRes.data?.data?.accessKey;
        if (!key) {
          printError('Create key failed: no key in response');
          process.exit(ERROR_CODES.API_REQUEST);
        }

        // Quiet mode: emit only the export line (the key is a valid Bearer credential).
        if (quiet) {
          console.log(`export PLATFORM_TOKEN=${key}`);
          return;
        }

        console.log('');
        printSuccess('Access key created');
        console.log('');
        printKeyValue({
          'Name': meta?.name ?? name,
          'Key ID': meta?.id ?? '(unknown)',
          'Key': meta?.display ?? '(unknown)',
          'Expires': meta?.expiresAt ?? `${days} day(s)`,
          ...(meta?.scope ? { Scope: meta.scope } : {}),
        });
        console.log('');
        console.log(yellow(bold('Copy your key now — only its hash is stored, so it will not be shown again:')));
        console.log(green(key));
        console.log('');
        printInfo('Tip: use it as PLATFORM_TOKEN for subsequent commands:');
        console.log(green('  export PLATFORM_TOKEN=<token>'));
        console.log(green(`  # or:  eval $(pipeline-manager auth pat --name ${name} --quiet)`));
      } catch (error) {
        if (error instanceof DeviceAuthError) {
          printError(`Create key failed: ${error.message}`, { reason: error.code });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;
          printError('Create key failed', {
            status: status ?? 'no response',
            ...(message ? { message } : {}),
          });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'create-pat', executionId, url: options.url },
        });
      }
    });
}
