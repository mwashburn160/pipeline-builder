// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { errorMessage, isOpaqueApiKey } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { STORE_TOKEN_SCOPES } from './store-token.js';
import { resolveAwsRegion } from '../utils/aws-env.js';
import { getSecretValue, listSecrets } from '../utils/aws-secrets.js';
import { printCommandHeader, withProfileOption, withRegionOption } from '../utils/command-utils.js';
import { ERROR_CODES, reportError } from '../utils/error-handler.js';
import { printError, printInfo, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { scopeSecretLeaf } from '../utils/platform-secret.js';

interface TokenAuditEntry {
  secretName: string;
  arn: string;
  /** Absent only for an `unverifiable` secret that records no usable expiry. */
  expiresAt?: Date;
  daysUntilExpiry?: number;
  status: 'expired' | 'expiring-soon' | 'unverifiable' | 'ok';
  /** Why the stored token failed verification, when `status` is `unverifiable`. */
  reason?: string;
}

/**
 * Registers the `audit-tokens` command with the CLI program.
 *
 * Scans AWS Secrets Manager for stored service-account keys (matching the
 * `pipeline-builder/<orgId>/platform` naming convention used by `store-token`)
 * and reports which secrets are expired or close to expiring.
 *
 * Designed for cron use:
 *   - Exits 0 when nothing is at-risk.
 *   - Exits 1 when at least one secret is expired, expires within `--warn-days`,
 *     or holds a credential that cannot be checked or used.
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

        // Audit every stored machine credential: the platform key
        // (`<prefix>/<orgId>/platform`) and each SCOPED one `store-token --scope …`
        // writes (`.../reporting-ingest`, `.../registry-push`,
        // `.../pipeline-registry-write`). All expire and all are auto-rotated, so
        // a stalled rotation on any of them must surface here. Derived from
        // store-token's own scope list so a new scope cannot go unaudited.
        const CREDENTIAL_LEAVES = ['platform', ...STORE_TOKEN_SCOPES.map(scopeSecretLeaf)].map((leaf) => `/${leaf}`);
        const platformSecrets = secrets.filter((s) => CREDENTIAL_LEAVES.some((leaf) => s.name.endsWith(leaf)));

        const entries: TokenAuditEntry[] = [];
        // Secrets the scan could not READ (AWS error). Skipping them silently
        // let an access-denied or throttled sweep report "all clear" and exit 0.
        const unreadable: Array<{ secretName: string; error: string }> = [];
        const now = Date.now();
        const warnCutoff = now + warnDays * 24 * 60 * 60 * 1000;

        for (const s of platformSecrets) {
          let raw: string;
          try {
            raw = await getSecretValue(s.name, { region, profile: options.profile });
          } catch (err) {
            printWarning(`Could not read ${s.name}: ${errorMessage(err)}`);
            unreadable.push({ secretName: s.name, error: errorMessage(err) });
            continue;
          }

          let parsed: { password?: string; expiresAt?: string; platformUrl?: string };
          try {
            parsed = JSON.parse(raw);
          } catch {
            // No consumer can use it either: a broken credential, not a skip.
            entries.push({ secretName: s.name, arn: s.arn, status: 'unverifiable', reason: 'is not valid JSON — re-run "pipeline-manager infra store-token"' });
            continue;
          }

          // `expiresAt` is the ONLY expiry source now. The stored credential is an
          // opaque service-account key: it carries no claims, so there is no `exp`
          // to decode as a fallback — which is exactly why store-token and the
          // rotator both write the field.
          let expiresAt: Date | undefined;
          if (parsed.expiresAt) {
            const d = new Date(parsed.expiresAt);
            if (!Number.isNaN(d.getTime())) expiresAt = d;
          }
          if (!expiresAt) {
            // Its expiry can't be checked, so it can't be reported as fine.
            entries.push({ secretName: s.name, arn: s.arn, status: 'unverifiable', reason: 'records no expiresAt — re-run "pipeline-manager infra store-token"' });
            continue;
          }

          const daysUntilExpiry = Math.floor((expiresAt.getTime() - now) / (24 * 60 * 60 * 1000));
          let status: TokenAuditEntry['status'] =
            expiresAt.getTime() < now ? 'expired'
              : expiresAt.getTime() < warnCutoff ? 'expiring-soon'
                : 'ok';

          // A secret that still has months of life but holds the WRONG KIND of
          // credential is just as dead as an expired one. After the service-account
          // cutover the stored value must be an opaque `pb_sa_…` key; a secret left
          // holding a pre-cutover machine-session JWT is refused by every consumer,
          // and this is the scan that names it instead of leaving three services to
          // fail with an opaque 401.
          let reason: string | undefined;
          if (status !== 'expired' && parsed.password && !isOpaqueApiKey(parsed.password)) {
            status = 'unverifiable';
            reason = parsed.password.split('.').length === 3
              ? 'holds a pre-cutover JWT, not a service-account key — re-run "pipeline-manager infra store-token"'
              : 'does not hold an opaque service-account key (expected a "pb_sa_…" value)';
          }
          entries.push({ secretName: s.name, arn: s.arn, expiresAt, daysUntilExpiry, status, ...(reason ? { reason } : {}) });
        }

        const atRisk = entries.filter((e) => e.status !== 'ok');
        // A truncated scan is itself a failure condition: exit non-zero so cron
        // doesn't read an incomplete "all clear" as success. An unreadable secret
        // is a scan failure (exit 2), per the contract above.
        const exitCode = unreadable.length > 0 ? 2 : (atRisk.length > 0 || truncated) ? 1 : 0;

        if (options.json) {
          console.log(JSON.stringify({
            scannedAt: new Date().toISOString(),
            region,
            warnDays,
            totalScanned: entries.length,
            atRiskCount: atRisk.length,
            truncated,
            unreadable,
            entries: entries.map((e) => ({ ...e, ...(e.expiresAt ? { expiresAt: e.expiresAt.toISOString() } : {}) })),
            executionId,
          }, null, 2));
        } else {
          printSection('Audit Results');
          printInfo(`Scanned ${entries.length} platform secret${entries.length === 1 ? '' : 's'}`);
          if (unreadable.length > 0) {
            printError(`${unreadable.length} secret${unreadable.length === 1 ? '' : 's'} could not be read — the audit is INCOMPLETE.`);
          }
          if (atRisk.length === 0) {
            if (unreadable.length > 0) {
              printWarning('No at-risk tokens among the secrets that could be read.');
            } else if (truncated) {
              printWarning('No at-risk tokens in the scanned pages, but the scan was truncated — some secrets were not checked.');
            } else {
              printSuccess(`All stored keys valid for at least ${warnDays} days`);
            }
          } else {
            for (const e of atRisk) {
              const days = e.daysUntilExpiry ?? 0;
              const label = e.status === 'unverifiable'
                ? `UNUSABLE — ${e.reason}`
                : e.status === 'expired'
                  ? `EXPIRED ${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
                  : `expires in ${days} day${days === 1 ? '' : 's'}`;
              printWarning(`${e.secretName} — ${label}`);
            }
            printError(`${atRisk.length} secret${atRisk.length === 1 ? '' : 's'} need rotation. Run \`pipeline-manager infra store-token --expires-days <N>\` (add --scope for a scoped credential) to reissue.`);
          }
        }
        process.exit(exitCode);
      } catch (error) {
        reportError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          context: { command: 'audit-tokens', executionId },
        });
        process.exit(2);
      }
    });
}
