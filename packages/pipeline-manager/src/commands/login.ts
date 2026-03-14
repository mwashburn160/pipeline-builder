import https from 'https';
import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printDebug, printError, printInfo, printSection, printSuccess } from '../utils/output-utils';

const { bold, cyan, green, magenta } = pico;

/**
 * Expected shape of the login API response.
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
 * ```
 */
export function login(program: Command): void {
  program
    .command('login')
    .description('Authenticate with the platform and obtain a PLATFORM_TOKEN')
    .requiredOption('-u, --identifier <identifier>', 'Username or email')
    .requiredOption('-p, --password <password>', 'Password')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action(async (options) => {
      const executionId = generateExecutionId();

      try {
        const quiet = options.quiet ?? false;

        if (!quiet) {
          printSection('Login');
          console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Platform Authentication'))}`);
          console.log('');
          printInfo('Authenticating', {
            identifier: options.identifier,
            url: options.url,
            verifySsl: options.verifySsl,
          });
        }

        const httpsAgent = new https.Agent({
          rejectUnauthorized: options.verifySsl ?? true,
        });

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

        const token = response.data?.data?.accessToken;

        if (!token) {
          printError('Login failed: no access token in response');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        if (!quiet) {
          console.log('');
          printSuccess('Login successful');
          console.log('');
        }

        console.log(`export PLATFORM_TOKEN=${token}`);

        if (!quiet) {
          console.log('');
          printInfo('Tip: Run the following to set the token in your shell:');
          console.log(green(`  eval $(pipeline-manager login -u ${options.identifier} -p '***' --quiet)`));
        }
      } catch (error) {
        // Provide a clear "Login failed" message for auth errors
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;

          printError('Login failed', {
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
