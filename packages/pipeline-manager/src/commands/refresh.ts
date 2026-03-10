import https from 'https';
import { Command } from 'commander';
import axios from 'axios';
import pico from 'picocolors';
import { generateExecutionId } from '../config/cli.constants';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printDebug, printError, printInfo, printSection, printSuccess } from '../utils/output-utils';

const { bold, cyan, green, magenta } = pico;

/**
 * Expected shape of the refresh API response.
 */
interface RefreshResponse {
  success: boolean;
  data: {
    accessToken: string;
    refreshToken: string;
  };
}

/**
 * Registers the `refresh` command with the CLI program.
 *
 * Exchanges a refresh token for a new access token and prints an export
 * statement for `PLATFORM_TOKEN` on success.
 *
 * @param program - The root Commander program instance to attach the command to.
 *
 * @example
 * ```bash
 * pipeline-manager refresh --token <refresh-token>
 * pipeline-manager refresh -t <refresh-token> --url https://myhost:8443
 * eval $(pipeline-manager refresh -t <refresh-token> --quiet)
 * ```
 */
export function refresh(program: Command): void {
  program
    .command('refresh')
    .description('Exchange a refresh token for a new PLATFORM_TOKEN')
    .requiredOption('-t, --token <refreshToken>', 'Refresh token from a previous login')
    .option('--url <url>', 'Platform base URL', process.env.PLATFORM_BASE_URL || 'https://localhost:8443')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .option('--quiet', 'Only print the export statement (useful for eval)')
    .action(async (options) => {
      const executionId = generateExecutionId();

      try {
        const quiet = options.quiet ?? false;

        if (!quiet) {
          printSection('Refresh Token');
          console.log(`${magenta(`[EXE-${executionId}]`)} ${cyan(bold('Token Refresh'))}`);
          console.log('');
          printInfo('Refreshing access token', {
            url: options.url,
            verifySsl: options.verifySsl,
          });
        }

        const httpsAgent = new https.Agent({
          rejectUnauthorized: options.verifySsl ?? true,
        });

        const refreshUrl = `${options.url}/api/auth/refresh`;
        printDebug('POST', { url: refreshUrl });

        const response = await axios.post<RefreshResponse>(
          refreshUrl,
          { refreshToken: options.token },
          {
            headers: { 'Content-Type': 'application/json' },
            httpsAgent,
            timeout: 30000,
          },
        );

        const accessToken = response.data?.data?.accessToken;

        if (!accessToken) {
          printError('Token refresh failed: no access token in response');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        if (!quiet) {
          console.log('');
          printSuccess('Token refreshed successfully');
          console.log('');
        }

        console.log(`export PLATFORM_TOKEN=${accessToken}`);

        if (!quiet) {
          console.log('');
          printInfo('Tip: Run the following to set the token in your shell:');
          console.log(green(`  eval $(pipeline-manager refresh -t '<refresh-token>' --quiet)`));
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const message = (error.response?.data as { message?: string })?.message;

          printError('Token refresh failed', {
            status: status ?? 'no response',
            ...(message ? { message } : {}),
          });
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        handleError(error, ERROR_CODES.AUTHENTICATION, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'refresh',
            executionId,
            url: options.url,
          },
        });
      }
    });
}
