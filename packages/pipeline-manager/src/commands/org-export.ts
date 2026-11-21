// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { Command } from 'commander';
import pico from 'picocolors';
import { TIMEOUTS } from '../config/cli.constants.js';
import { assertCredentialTlsAllowed } from '../utils/auth-utils.js';
import { printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId, withSslOptions } from '../utils/command-utils.js';
import { getApiConfig } from '../utils/config-loader.js';
import { beginDeviceApproval, pollForDeviceToken } from '../utils/device-auth.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printDebug, printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils.js';
import { requestCorrelationHeaders } from '../utils/request-context.js';
import { platformHttpsAgent } from '../utils/tls.js';

const { bold, green } = pico;

/**
 * CLI  `pipeline-manager org export --id <orgId> --output <file>`.
 *
 * Fetches the GDPR portability dump from `GET /api/organization/:id/export`
 * on the platform service and writes it to disk, readable by the current user
 * only. The endpoint is gated server-side:
 * • System admins (admin/owner in the `system` org) may export any org.
 * • Org admins / owners may export ONLY their own org.
 * • Everything else gets 403.
 *
 * The export is also step-up gated (a fresh re-authentication). The CLI holds
 * no password, so — like `auth pat` — it runs a device sign-in that asks for the
 * step-up IN THE BROWSER, then spends the returned short-lived step-up token
 * with that same session's bearer (the token is bound to the user who approved
 * it). The CLI does no role checking itself: the approving user's role and
 * active org decide what the server accepts.
 *
 * @example
 * ```bash
 * # Sysadmin: any org
 * pipeline-manager org export --id org-acme --output acme.json
 *
 * # Org admin: own org only (server rejects other ids with 403)
 * pipeline-manager org export --id org-acme --output acme.json
 * ```
 */
export function orgExport(program: Command): void {
  withSslOptions(program
    .command('export')
    .description('Export an organization\'s data as JSON (GDPR portability: sysadmins any org, org admins their own)')
    .requiredOption('-i, --id <id>', 'Organization ID to export')
    .option('-o, --output <file>', 'Output file path (default: org-<id>-export.json in CWD)')
    .option('--no-browser', 'Never open a browser — print the verification URL instead')
    .option('--url <url>', 'Platform base URL (default: PLATFORM_BASE_URL, else the platform you last signed in to, else config.yml)'))
    .action(async (options) => {
      const executionId = printCommandHeader('Org Export');

      try {
        printSslWarning(options.verifySsl);
        // The device poll returns a session and a step-up token: never over an
        // unverified connection in production (same guard as `auth pat`).
        assertCredentialTlsAllowed(options.verifySsl);
        const url: string = options.url ?? getApiConfig().api.baseUrl;

        const orgId = validateEntityId(options.id, 'Organization');
        const outputPath = options.output
          ? path.resolve(options.output)
          : path.resolve(process.cwd(), `org-${orgId}-export.json`);

        printInfo('Request parameters', {
          orgId,
          output: outputPath,
        });

        const httpsAgent = platformHttpsAgent(options.verifySsl);
        const transport = { url, httpsAgent, timeout: TIMEOUTS.HTTP_REQUEST };

        // 1) Device sign-in asking for the step-up the export needs.
        const code = await beginDeviceApproval(transport, {
          quiet: false,
          browser: options.browser,
          verifySsl: options.verifySsl,
          stepUp: true,
        });
        const session = await pollForDeviceToken(transport, code);
        if (!session.step_up_token) {
          printError('The approval did not return a step-up confirmation — approve the code promptly and try again.');
          process.exit(ERROR_CODES.AUTHENTICATION);
        }

        console.log('');
        printSection('Fetching Export');

        // 2) Fetch the export at once: the step-up token is short-lived and
        //    single-use. The body is JSON, re-serialized to disk below.
        const startTime = Date.now();
        const exportUrl = `${url}/api/organization/${encodeURIComponent(orgId)}/export`;
        printDebug('GET', { url: exportUrl });
        const { data: response } = await axios.get<Record<string, unknown>>(exportUrl, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'X-Step-Up-Token': session.step_up_token,
            ...requestCorrelationHeaders(),
          },
          httpsAgent,
          // A long-history org's dump is large: allow far longer than a normal call.
          timeout: TIMEOUTS.HTTP_REQUEST * 10,
        });
        const duration = Date.now() - startTime;

        if (!response || typeof response !== 'object') {
          printError('Empty / unparseable export payload');
          throw new Error(`Export returned no data for org ${orgId}`);
        }

        // Re-serialize so we keep the same pretty-printed shape the server
        // produced (2-space indent matches the platform's handler) and so
        // we don't lose Date precision on a round-trip through JSON.parse.
        //
        // GUARD: this writes the raw server payload straight to disk. The export
        // payload must NEVER contain an AWS account id — orgId is the platform org
        // id, never an AWS account id. It is account-id-free today;
        // if a future server change ever adds one, it must be stripped/redacted
        // here BEFORE this write, not persisted through the CLI.
        const json = JSON.stringify(response, null, 2);
        // The dump names the org's members (emails included) and every record it
        // owns: owner-only, like the credential store. `mode` applies only when
        // the file is created, so an existing file is tightened as well.
        fs.writeFileSync(outputPath, json, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(outputPath, 0o600);

        const sizeKb = (json.length / 1024).toFixed(1);
        const postgresTables = response.postgres && typeof response.postgres === 'object'
          ? Object.keys(response.postgres as Record<string, unknown>).length
          : 0;

        console.log('');
        printSection('Export Saved');
        printKeyValue({
          'Org ID': green(bold(orgId)),
          'Output': outputPath,
          'Size': `${sizeKb} KB`,
          'Postgres tables': String(postgresTables),
          'Exported at': typeof response.exportedAt === 'string' ? response.exportedAt: '(not set)',
        });

        printExecutionSummary(executionId, duration);
        printSuccess('Organization export complete', { path: outputPath });
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: { command: 'org-export', executionId, orgId: options.id },
        });
      }
    });
}
