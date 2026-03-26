import https from 'https';
import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printDebug, printError, printInfo, printSection, printSuccess } from '../utils/output-utils';
import { checkAuthRateLimit, recordAuthFailure, recordAuthSuccess } from '../utils/rate-limiter';

const { bold, cyan, green, magenta } = pico;

/**
 * Expected shape of the login/refresh API response.
 */
interface LoginResponse {
  success: boolean;
  data: {
    accessToken: string;
    refreshToken: string;
  };
}

/**
 * Registers the `login` command with the CLI program.
 *
 * Authenticates against the platform API and prints an export statement
 * for `PLATFORM_TOKEN` on success.  Does NOT require `PLATFORM_TOKEN`
 * to be set beforehand (unlike other commands).
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * pipeline-manager login --identifier admin@example.com --password secret
 * pipeline-manager login -u admin@example.com -p secret
 * pipeline-manager login -u admin@example.com -p secret --url https://myhost:8443
 * eval $(pipeline-manager login -u admin@example.com -p secret --quiet)
 * pipeline-manager login --refresh <refresh-token>
 * ```
 */
export function login(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the platform and obtain a PLATFORM_TOKEN')
    .option('-u, --identifier <identifier>', 'Username or email')
    .option('-p, --password <password>', 'Password')
    .option('--refresh <refreshToken>', 'Use a refresh token instead of login credentials')
    .option('--org <orgId>', 'Switch to a specific organization after login')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action(async (options) => {
      const executionId = generateExecutionId();
      const isRefresh = !!options.refresh;

      try {

        // Validate required options
        if (!isRefresh && (!options.identifier || !options.password)) {
          printError('Login requires --identifier and --password, or --refresh <token>');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        // Rate limiting — prevent brute force (login only)
        if (!isRefresh) {
          const rateLimitMsg = checkAuthRateLimit();
          if (rateLimitMsg) {
            printError(rateLimitMsg);
            process.exit(ERROR_CODES.AUTHENTICATION);
          }
        }

        const quiet = options.quiet ?? false;

        if (!quiet) {
          printSection(isRefresh ? 'Token Refresh' : 'Login');
          console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold(isRefresh ? 'Token Refresh' : 'Platform Authentication'))}`);
          console.log('');
          printInfo(isRefresh ? 'Refreshing access token' : 'Authenticating', {
            ...(options.identifier ? { identifier: options.identifier } : {}),
            url: options.url,
            verifySsl: options.verifySsl,
          });
        }

        const httpsAgent = new https.Agent({
          rejectUnauthorized: options.verifySsl ?? true,
        });

        let token: string | undefined;

        if (isRefresh) {
          const refreshUrl = `${options.url}/api/auth/refresh`;
          printDebug('POST', { url: refreshUrl });

          const response = await axios.post<LoginResponse>(
            refreshUrl,
            { refreshToken: options.refresh },
            {
              headers: { 'Content-Type': 'application/json' },
              httpsAgent,
              timeout: 30000,
            },
          );

          token = response.data?.data?.accessToken;
        } else {
          const loginUrl = `${options.url}/api/auth/login`;
          printDebug('POST', { url: loginUrl });

          const response = await axios.post<LoginResponse>(
            loginUrl,
            {
              identifier: options.identifier,
              password: options.password,
            },
            {
              headers: { 'Content-Type': 'application/json' },
              httpsAgent,
              timeout: 30000,
            },
          );

          token = response.data?.data?.accessToken;
        }

        if (!token) {
          if (!isRefresh) recordAuthFailure();
          printError(`${isRefresh ? 'Token refresh' : 'Login'} failed: no access token in response`);
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        if (!isRefresh) recordAuthSuccess();

        // Switch to a specific organization if --org is provided
        if (options.org) {
          if (!quiet) {
            printInfo('Switching to organization', { orgId: options.org });
          }

          const switchUrl = `${options.url}/api/auth/switch-org`;
          printDebug('POST', { url: switchUrl });

          const switchResponse = await axios.post<LoginResponse>(
            switchUrl,
            { organizationId: options.org },
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
              },
              httpsAgent,
              timeout: 30000,
            },
          );

          const switchedToken = switchResponse.data?.data?.accessToken;
          if (!switchedToken) {
            printError('Organization switch failed: no access token in response');
            process.exit(ERROR_CODES.AUTHENTICATION);
          }

          token = switchedToken;

          if (!quiet) {
            printSuccess(`Switched to organization ${options.org}`);
          }
        }

        if (!quiet) {
          console.log('');
          printSuccess(isRefresh ? 'Token refreshed successfully' : 'Login successful');
          console.log('');
        }

        console.log(`export PLATFORM_TOKEN=${token}`);

        if (!quiet) {
          console.log('');
          printInfo('Tip: Run the following to set the token in your shell:');
          const orgFlag = options.org ? ` --org ${options.org}` : '';
          if (isRefresh) {
            console.log(green(`  eval $(pipeline-manager login --refresh '<refresh-token>'${orgFlag} --quiet)`));
          } else {
            console.log(green(`  eval $(pipeline-manager login -u ${options.identifier} -p '***'${orgFlag} --quiet)`));
          }
        }
      } catch (error) {
        if (!isRefresh) recordAuthFailure();
        // Provide a clear failure message for auth errors
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;

          printError(`${isRefresh ? 'Token refresh' : 'Login'} failed`, {
            status: status ?? 'no response',
            ...(message ? { message } : {}),
          });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        handleError(error, ERROR_CODES.AUTHENTICATION, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'login',
            executionId,
            identifier: options.identifier,
            url: options.url,
          },
        });
      }
    });
}
