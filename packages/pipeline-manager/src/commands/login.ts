// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { TIMEOUTS } from '../config/cli.constants.js';
import { assertCredentialTlsAllowed, credentialHttpsAgent, switchOrganization } from '../utils/auth-utils.js';
import { printCommandHeader, withSslOptions } from '../utils/command-utils.js';
import { credentialStorePath, saveSession } from '../utils/credential-store.js';
import { DeviceAuthError, openInBrowser, pollForDeviceToken, requestDeviceCode } from '../utils/device-auth.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printError, printInfo, printSuccess } from '../utils/output-utils.js';

const { bold, cyan, dim, green } = pico;

/**
 * Registers the `login` command with the CLI program.
 *
 * Signs in with the OAuth 2.0 device authorization grant (RFC 8628): the CLI
 * shows a short code, the person approves it in a browser, and the CLI receives
 * an ordinary session. There is no password flag and no way to hand the CLI a
 * refresh token — both end up in shell history, `ps` output and CI logs, and
 * both skip the SSO / step-up / MFA the browser already enforces.
 *
 * The session is written to the credential store (`~/.pipeline-manager/
 * credentials.json`, owner-only), so subsequent commands authenticate with no
 * environment variable at all. `PLATFORM_TOKEN` still wins when it is set, which
 * is what CI uses — an access key from `auth pat`.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * pipeline-manager auth login
 * pipeline-manager auth login --url https://platform.example.com --org <orgId>
 * pipeline-manager auth login --no-browser      # print the URL instead of opening it
 * eval $(pipeline-manager auth login --quiet)   # also export PLATFORM_TOKEN
 * ```
 */
export function login(program: Command): void {
  withSslOptions(program
    .command('login')
    .description('Sign in through your browser and store the session (device authorization)')
    .option('--org <orgId>', 'Switch to a specific organization after signing in')
    .option('--no-browser', 'Never open a browser — print the verification URL instead')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443'))
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .option('--token', 'Print ONLY the access token, for `export PLATFORM_TOKEN=$(…)`')
    .action(async (options, command: Command) => {
      // `--quiet` is ALSO a program-level option, and Commander binds a trailing
      // `--quiet` to the program rather than to this subcommand — so
      // `options.quiet` here is never set and the documented
      // `eval $(pipeline-manager auth login --quiet)` could not work. Read the
      // value that actually lands: this command's own flag if Commander ever
      // gives it to us, else the root program's.
      const rootQuiet = (command?.parent?.parent as Command | undefined)?.opts?.().quiet;
      // `--token` prints the bare token for `$(…)` capture, so it silences the
      // same chrome `--quiet` does. Read from argv as well: the banner is
      // decided from argv before Commander parses (see cli.ts's entry), so the
      // two have to agree or the banner lands on stdout and poisons the capture.
      const tokenOnly = (options.token ?? process.argv.includes('--token')) as boolean;
      const quiet = (options.quiet ?? rootQuiet ?? false) as boolean || tokenOnly;
      const executionId = printCommandHeader('Login', 'Platform Authentication', { quiet });

      // SECURITY: the poll returns session tokens — bearer credentials. Never
      // fetch them over an unverified TLS connection in production.
      assertCredentialTlsAllowed(options.verifySsl);

      try {
        const transport = {
          url: options.url,
          httpsAgent: credentialHttpsAgent(options.verifySsl),
          timeout: TIMEOUTS.HTTP_REQUEST,
        };

        if (!quiet) printInfo('Starting browser sign-in', { url: options.url, verifySsl: options.verifySsl });

        const code = await requestDeviceCode(transport);
        const approvalUrl = code.verification_uri_complete || code.verification_uri;
        // `--no-browser` sets options.browser to false (commander's --no- pair).
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
        let refreshToken = session.refresh_token;
        let expiresIn = session.expires_in;

        // Switching re-issues (and rotates) the session, so the store has to take
        // the NEW pair — keeping the old refresh token would strand the session.
        if (options.org) {
          if (!quiet) printInfo('Switching to organization', { orgId: options.org });
          const switched = await switchOrganization({
            url: options.url,
            orgId: options.org,
            accessToken,
            httpsAgent: transport.httpsAgent,
            timeout: TIMEOUTS.HTTP_REQUEST,
            quiet,
          });
          accessToken = switched.accessToken;
          refreshToken = switched.refreshToken ?? refreshToken;
          expiresIn = switched.expiresIn ?? expiresIn;
        }

        saveSession(options.url, {
          accessToken,
          ...(refreshToken ? { refreshToken } : {}),
          expiresAt: Date.now() + expiresIn * 1000,
          ...(options.org ? { organizationId: options.org } : {}),
        });

        if (tokenOnly) {
          // The token and NOTHING else — the caller writes the export.
          console.log(accessToken);
          return;
        }
        if (quiet) {
          console.log(`export PLATFORM_TOKEN=${accessToken}`);
          return;
        }

        console.log('');
        printSuccess('Signed in');
        console.log('');
        printInfo('The session is stored for this platform — other commands pick it up automatically.', {
          store: credentialStorePath(),
        });
        console.log('');
        printInfo('Tip: to export it into this shell instead:');
        console.log(green(`  export PLATFORM_TOKEN=$(pipeline-manager auth login${options.org ? ` --org ${options.org}` : ''} --token)`));
        console.log('');
        printInfo('Sign this device out again from Settings → Sessions and devices.');
      } catch (error) {
        if (error instanceof DeviceAuthError) {
          printError(`Login failed: ${error.message}`, { reason: error.code });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;
          printError('Login failed', { status: status ?? 'no response', ...(message ? { message } : {}) });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        handleError(error, ERROR_CODES.AUTHENTICATION, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'login', executionId, url: options.url },
        });
      }
    });
}
