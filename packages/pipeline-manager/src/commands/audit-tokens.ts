// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { decodeTokenPayload } from '../utils/auth-guard';
import { getSecretValue, listSecrets } from '../utils/aws-secrets';
import { printCommandHeader } from '../utils/command-utils';
import { ERROR_CODES, handleError } from '../utils/error-handler';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils';

interface TokenAuditEntry {
  secretName: string;
  arn: string;
  expiresAt: Date;
  daysUntilExpiry: number;
  status: 'expired' | 'expiring-soon' | 'ok';
}

/**
 * Registers the `audit-tokens` command with the CLI program.
 *
 * Scans AWS Secrets Manager for stored platform JWTs (matching the
 * `pipeline-builder/<orgId>/platform` naming convention used by `store-token`)
 * and reports which secrets are expired or close to expiring.
 *
 * Designed for cron use:
 *   - Exits 0 when nothing is at-risk.
 *   - Exits 1 when at least one secret is expired or expires within `--warn-days`.
 *   - Exits 2 on AWS errors / scan failures.
 *
 * @example
 * ```bash
 * pipeline-manager audit-tokens --region us-east-1 --warn-days 7
 * pipeline-manager audit-tokens --region us-east-1 --json
 * ```
 */
export function auditTokens(program: Command): void {
  program
    .command('audit-tokens')
    .description('Scan stored platform tokens in AWS Secrets Manager and report upcoming expirations')
    .option('--region <region>', 'AWS region (defaults to AWS_REGION env)')
    .option('--profile <profile>', 'AWS CLI profile', 'default')
    .option('--warn-days <days>', 'Flag tokens expiring within N days as at-risk', '7')
    .option('--prefix <prefix>', 'Secrets Manager name prefix to scan', `${CoreConstants.SECRETS_PATH_PREFIX}/`)
    .option('--json', 'Output results as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Audit Tokens');
      const region = options.region || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
      const warnDays = parseInt(options.warnDays, 10);
      if (!Number.isFinite(warnDays) || warnDays < 0) {
        printError('Invalid --warn-days value', { provided: options.warnDays });
        process.exit(2);
      }

      try {
        printInfo('Listing secrets', { region, prefix: options.prefix });
        const secrets = await listSecrets(options.prefix, { region, profile: options.profile });

        // Filter to ones following the `<prefix>/<orgId>/platform` pattern.
        const platformSecrets = secrets.filter((s) => s.name.endsWith('/platform'));

        const entries: TokenAuditEntry[] = [];
        const now = Date.now();
        const warnCutoff = now + warnDays * 24 * 60 * 60 * 1000;

        for (const s of platformSecrets) {
          let raw: string;
          try {
            raw = await getSecretValue(s.name, { region, profile: options.profile });
          } catch (err) {
            printWarning(`Could not read ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }

          let parsed: { accessToken?: string; expiresAt?: string };
          try {
            parsed = JSON.parse(raw);
          } catch {
            printWarning(`Secret ${s.name} is not valid JSON, skipping`);
            continue;
          }

          // Prefer the explicit expiresAt field written by store-token; fall back
          // to decoding the JWT's exp claim if the field is missing.
          let expiresAt: Date | undefined;
          if (parsed.expiresAt) {
            const d = new Date(parsed.expiresAt);
            if (!Number.isNaN(d.getTime())) expiresAt = d;
          }
          if (!expiresAt && parsed.accessToken) {
            const payload = decodeTokenPayload(parsed.accessToken);
            if (payload?.exp && typeof payload.exp === 'number') {
              expiresAt = new Date(payload.exp * 1000);
            }
          }
          if (!expiresAt) {
            printWarning(`Secret ${s.name} has no expiry information, skipping`);
            continue;
          }

          const daysUntilExpiry = Math.floor((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000));
          const status: TokenAuditEntry['status'] =
            expiresAt.getTime() < now ? 'expired'
              : expiresAt.getTime() < warnCutoff ? 'expiring-soon'
              : 'ok';
          entries.push({ secretName: s.name, arn: s.arn, expiresAt, daysUntilExpiry, status });
        }

        const atRisk = entries.filter((e) => e.status !== 'ok');
        const exitCode = atRisk.length > 0 ? 1 : 0;

        if (options.json) {
          console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            region,
            warnDays,
            totalScanned: entries.length,
            atRiskCount: atRisk.length,
            entries: entries.map((e) => ({ ...e, expiresAt: e.expiresAt.toISOString() })),
            executionId,
          }, null, 2));
        } else {
          printSection('Audit Results');
          printInfo(`Scanned ${entries.length} platform secret${entries.length === 1 ? '' : 's'}`);
          if (atRisk.length === 0) {
            printSuccess(`All tokens valid for at least ${warnDays} days`);
          } else {
            for (const e of atRisk) {
              const label = e.status === 'expired'
                ? `EXPIRED ${Math.abs(e.daysUntilExpiry)} day${e.daysUntilExpiry === -1 ? '' : 's'} ago`
                : `expires in ${e.daysUntilExpiry} day${e.daysUntilExpiry === 1 ? '' : 's'}`;
              printWarning(`${e.secretName} — ${label}`);
            }
            printError(`${atRisk.length} secret${atRisk.length === 1 ? '' : 's'} need rotation. Run \`pipeline-manager store-token --days <N>\` to refresh.`);
          }
        }
        process.exit(exitCode);
      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: false,
          context: { command: 'audit-tokens', executionId },
        });
        process.exit(2);
      }
    });
}
