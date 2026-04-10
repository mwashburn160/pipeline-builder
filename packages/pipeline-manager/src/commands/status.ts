// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import https from 'https';
import axios from 'axios';
import { Command } from 'commander';
import { ENV_VARS, TIMEOUTS } from '../config/cli.constants';
import { checkCdkAvailable } from '../utils/cdk-utils';
import { printCommandHeader } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printKeyValue, printSection } from '../utils/output-utils';

/**
 * Registers the `status` command with the CLI program.
 *
 * Checks environment variables, CDK availability, platform connectivity,
 * and token expiry to give a quick overview of the current setup.
 *
 * @param program - The root Commander program instance to attach the command to.
 */
export function status(program: Command): void {
  program
    .command('status')
    .description('Show environment and connectivity status')
    .option('--json', 'Output result as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Status');

      try {
        const results: Record<string, string> = {};

        // 1. Check PLATFORM_TOKEN
        const token = process.env[ENV_VARS.PLATFORM_TOKEN];
        results.PLATFORM_TOKEN = token ? 'set' : 'not set';

        // 2. Check PLATFORM_SECRET_NAME
        const secretName = process.env.PLATFORM_SECRET_NAME;
        results.PLATFORM_SECRET_NAME = secretName || 'not set';

        // 3. Check CDK availability
        results['CDK Available'] = checkCdkAvailable() ? 'yes' : 'no';

        // 4. Check platform health
        const baseUrl = process.env[ENV_VARS.PLATFORM_BASE_URL] || 'https://localhost:8443';
        results.PLATFORM_BASE_URL = baseUrl;

        try {
          const httpsAgent = new https.Agent({ rejectUnauthorized: false });
          await axios.get(`${baseUrl}/health`, {
            timeout: TIMEOUTS.HEALTH_CHECK,
            httpsAgent,
          });
          results['Platform Health'] = 'reachable';
        } catch {
          results['Platform Health'] = 'unreachable';
        }

        // 5. Decode token expiry
        if (token) {
          try {
            const parts = token.split('.');
            if (parts.length === 3 && parts[1]) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
              if (typeof payload.exp === 'number') {
                const expiresAt = new Date(payload.exp * 1000);
                results['Token Expires'] = expiresAt.toISOString();
                results['Token Expired'] = expiresAt.getTime() < Date.now() ? 'yes' : 'no';
              }
            }
          } catch {
            results['Token Expires'] = 'unable to decode';
          }
        }

        if (options.json) {
          console.log(JSON.stringify({ success: true, executionId, ...results }, null, 2));
        } else {
          printSection('Environment Status');
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
