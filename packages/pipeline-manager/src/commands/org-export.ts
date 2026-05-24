// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import pico from 'picocolors';
import { createAuthenticatedClient, printCommandHeader, printExecutionSummary, printSslWarning, validateEntityId } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printKeyValue, printSection, printSuccess } from '../utils/output-utils';

const { bold, green } = pico;

/**
 * CLI  `pipeline-manager org-export --id <orgId> --output <file>`.
 *
 * Fetches the GDPR portability dump from `GET /api/organization/:id/export`
 * on the platform service and writes it to disk (or stdout). The endpoint
 * is gated server-side * • System admins (admin/owner in the `system` org) may export any org.
 * • Org admins / owners may export ONLY their own org.
 * • Everything else gets 403.
 *
 * The CLI itself does no role checking  the caller's PLATFORM_TOKEN drives
 * what the server accepts. Run `pipeline-manager status` first to confirm
 * the token's role + org.
 *
 * @example
 * ```bash
 * # Sysadmin: any org
 * pipeline-manager org-export --id org-acme --output acme.json
 *
 * # Org admin: own org only (server rejects other ids with 403)
 * pipeline-manager org-export --id org-acme --output acme.json
 * ```
 */
export function orgExport(program: Command): void {
  program
    .command('org-export')
    .description('Export an organization\'s data as JSON (GDPR portability, ).')
    .requiredOption('-i, --id <id>', 'Organization ID to export')
    .option('-o, --output <file>', 'Output file path (default: org-<id>-export.json in CWD)')
    .option('--verify-ssl', 'Enable SSL certificate verification')
    .option('--no-verify-ssl', 'Disable SSL certificate verification')
    .action(async (options) => {
      const executionId = printCommandHeader('Org Export');

      try {
        printSslWarning(options.verifySsl);

        const orgId = validateEntityId(options.id, 'Organization');
        const outputPath = options.output
          ? path.resolve(options.output)
          : path.resolve(process.cwd(), `org-${orgId}-export.json`);

        printInfo('Request parameters', {
          orgId,
          output: outputPath,
        });

        const client = createAuthenticatedClient(options);

        console.log('');
        printSection('Fetching Export');

        const startTime = Date.now();
        // The endpoint streams a large JSON attachment for orgs with long
        // histories. The ApiClient returns the parsed body directly, which
        // for `application/json` is a JS object we re-serialize to disk.
        const response = await client.get<Record<string, unknown>>( `${client.getConfig().api.baseUrl}/api/organization/${encodeURIComponent(orgId)}/export`,
        );
        const duration = Date.now() - startTime;

        if (!response || typeof response !== 'object') {
          printError('Empty / unparseable export payload');
          throw new Error(`Export returned no data for org ${orgId}`);
        }

        // Re-serialize so we keep the same pretty-printed shape the server
        // produced (2-space indent matches the platform's handler) and so
        // we don't lose Date precision on a round-trip through JSON.parse.
        const json = JSON.stringify(response, null, 2);
        fs.writeFileSync(outputPath, json, 'utf8');

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
