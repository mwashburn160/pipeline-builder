// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { decodeTokenPayload } from '../utils/auth-guard.js';
import { resolveAwsRegion } from '../utils/aws-env.js';
import { getSecretValue, listSecrets } from '../utils/aws-secrets.js';
import { printCommandHeader, withProfileOption, withRegionOption } from '../utils/command-utils.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils.js';

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
 * pipeline-manager audit tokens --region us-east-1 --warn-days 7
 * pipeline-manager audit tokens --region us-east-1 --json
 * ```
 */
export function auditTokens(program: Command): void {
  withProfileOption(
    withRegionOption(program
      .command('tokens')
      .description('Scan stored platform tokens in AWS Secrets Manager and report upcoming expirations')),
  )
    .option('--warn-days <days>', 'Flag tokens expiring within N days as at-risk', '7')
    .option('--prefix <prefix>', 'Secrets Manager name prefix to scan', `${CoreConstants.SECRETS_PATH_PREFIX}/`)
    .option('--json', 'Output results as JSON', false)
    .action(async (options) => {
      const executionId = printCommandHeader('Audit Tokens', undefined, { quiet: options.json });
      const region = resolveAwsRegion(options.region);
      const warnDays = parseInt(options.warnDays, 10);
      if (!Number.isFinite(warnDays) || warnDays < 0) {
        printError('Invalid --warn-days value', { provided: options.warnDays });
        process.exit(2);
      }

      try {
        // Progress goes to stdout, so suppress it in --json mode to keep the JSON payload clean for piping.
        if (!options.json) printInfo('Listing secrets', { region, prefix: options.prefix });
        const { secrets, truncated } = await listSecrets(options.prefix, { region, profile: options.profile });
        if (truncated) {
          // A truncated sweep means an expiring token past the cap could be missed —
          // never report "all clear" from an incomplete scan (mirrors audit-stacks).
          printWarning('Secret listing was TRUNCATED (paging cap hit) — results may be INCOMPLETE and an expiring token could be missed. Narrow by --prefix/--region.');
        }

        // Audit both the full-privilege platform token (`<prefix>/<orgId>/platform`)
        // AND the scoped event-ingestion token (`.../reporting-ingest`, minted by
        // `store-token --scope reporting:ingest`) — both expire and both are
        // auto-renewed, so a stalled renewal on either must surface here.
        const platformSecrets = secrets.filter((s) => s.name.endsWith('/platform') || s.name.endsWith('/reporting-ingest'));

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

          let parsed: { password?: string; expiresAt?: string };
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
          // `store-token` writes the JWT to the canonical `password` field.
          if (!expiresAt && parsed.password) {
            const payload = decodeTokenPayload(parsed.password);
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
        // A truncated scan is itself a failure condition: exit non-zero so cron
        // doesn't read an incomplete "all clear" as success.
        const exitCode = (atRisk.length > 0 || truncated) ? 1 : 0;

        if (options.json) {
          console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            region,
            warnDays,
            totalScanned: entries.length,
            atRiskCount: atRisk.length,
            truncated,
            entries: entries.map((e) => ({ ...e, expiresAt: e.expiresAt.toISOString() })),
            executionId,
          }, null, 2));
        } else {
          printSection('Audit Results');
          printInfo(`Scanned ${entries.length} platform secret${entries.length === 1 ? '' : 's'}`);
          if (atRisk.length === 0) {
            if (truncated) {
              printWarning('No at-risk tokens in the scanned pages, but the scan was truncated — some secrets were not checked.');
            } else {
              printSuccess(`All tokens valid for at least ${warnDays} days`);
            }
          } else {
            for (const e of atRisk) {
              const label = e.status === 'expired'
                ? `EXPIRED ${Math.abs(e.daysUntilExpiry)} day${e.daysUntilExpiry === -1 ? '' : 's'} ago`
                : `expires in ${e.daysUntilExpiry} day${e.daysUntilExpiry === 1 ? '' : 's'}`;
              printWarning(`${e.secretName} — ${label}`);
            }
            printError(`${atRisk.length} secret${atRisk.length === 1 ? '' : 's'} need rotation. Run \`pipeline-manager infra store-token --days <N>\` to refresh.`);
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
