// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { Command } from 'commander';
import { APP_VERSION, validateNumber } from '../config/cli.constants.js';
import { auditLog } from '../utils/audit-log.js';
import { resolveAwsRegion } from '../utils/aws-env.js';
import { upsertSecret, getSecretArn, getSecretValue } from '../utils/aws-secrets.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withRegionOption, withSslOptions } from '../utils/command-utils.js';
import { toEventBridgeCron } from '../utils/cron.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { ensurePlatformToken, scopeSecretLeaf, secretNameForOrg } from '../utils/platform-secret.js';
import { provisionServiceAccountKey, revokeServiceAccountKey } from '../utils/service-account.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENEW_STACK_NAME = 'pipeline-builder-token-renew';
// CFN-managed Lambda function name — keep in sync with token-renew-stack.json.
const RENEW_LAMBDA_NAME = 'pipeline-builder-token-renew';
// Default 5-field cron (daily at midnight) when neither --cron nor TOKEN_RENEW_SCHEDULE is set.
const DEFAULT_RENEW_CRON = '0 0 * * *';

/**
 * Capability scopes a stored credential may carry, and what each one is FOR.
 *
 * A scoped key exchanges to a token with no permissions and no admin flags at
 * all — only the one capability — so it is the shape every automation that does
 * exactly one thing should hold (#12). The unscoped `platform` credential is the
 * remaining full-privilege one: synth/deploy callbacks and the plugin-lookup
 * Lambda call the ordinary API surface, which no single scope covers.
 */
const SCOPE_CATALOG: Record<string, { account: string; description: string }> = {
  'reporting:ingest': {
    account: 'reporting-ingest',
    description: 'AWS pipeline-event ingestion (the events Lambda POSTs /reports/events)',
  },
  'registry:push': {
    account: 'registry-push',
    description: 'CI image pushes into this org’s registry namespace (CodeBuild → /token)',
  },
};

/** The account that holds the unscoped, full-privilege stored credential. */
const PLATFORM_ACCOUNT = {
  account: 'platform-automation',
  description: 'Stored platform credential for CDK synth/deploy, plugin lookup and image pushes',
};

/**
 * Deploy (or update) the once-a-day KEY ROTATION stack: a scheduled Lambda that
 * replaces the service-account key in this secret before it expires. Mirrors
 * setup-events — `aws cloudformation deploy` for the infra, then a direct
 * UpdateFunctionCode with the rotator handler compiled alongside this CLI (see
 * src/lambda/token-renew-handler.ts).
 */
async function deployRenewSchedule(opts: {
  platformUrl: string;
  secretName: string;
  days: number;
  fiveFieldCron: string;
  region: string;
  profile?: string;
}): Promise<string> {
  const scheduleExpression = toEventBridgeCron(opts.fiveFieldCron); // validates + 15-min guard

  // Name renewal resources per-secret so a scoped-credential stack (e.g. the
  // reporting-ingest key the event Lambda reads) coexists with the
  // platform-credential stack instead of colliding on the (account-global) IAM
  // role / Lambda / rule names. The platform secret keeps the bare name
  // (suffix '') so existing deployments' stack is updated in place, not
  // duplicated; any other secret appends its trailing path segment.
  const secretLeaf = opts.secretName.replace(/.*\//, ''); // 'platform' | 'reporting-ingest' | …
  const nameSuffix = secretLeaf === 'platform' ? '' : `-${secretLeaf.replace(/[^a-z0-9]+/gi, '-')}`;
  const stackName = `${RENEW_STACK_NAME}${nameSuffix}`;
  const lambdaName = `${RENEW_LAMBDA_NAME}${nameSuffix}`;

  printSection('Schedule Rotation');
  printInfo('Parameters', {
    stack: stackName,
    schedule: opts.fiveFieldCron,
    eventbridge: scheduleExpression,
    renewDays: opts.days,
  });

  // Step 1: infra (Lambda gets placeholder code on first create).
  const templatePath = path.join(__dirname, '../templates/token-renew-stack.json');
  const cfnArgs = [
    'cloudformation', 'deploy',
    '--stack-name', stackName,
    '--template-file', templatePath,
    '--parameter-overrides',
    `PlatformBaseUrl=${opts.platformUrl}`,
    `PlatformSecretName=${opts.secretName}`,
    `RenewDays=${opts.days}`,
    `ScheduleExpression=${scheduleExpression}`,
    `NameSuffix=${nameSuffix}`,
    // Recorded for provenance only — the rotator no longer installs the CLI at
    // runtime (it speaks to the platform directly), but knowing which CLI
    // deployed a stack is worth keeping.
    `PipelineManagerVersion=${APP_VERSION}`,
    '--capabilities', 'CAPABILITY_NAMED_IAM',
    '--no-fail-on-empty-changeset',
    '--region', opts.region,
  ];
  if (opts.profile) cfnArgs.push('--profile', opts.profile);
  execFileSync('aws', cfnArgs, { stdio: 'inherit' });

  // Step 2: upload the real handler. It's ESM, so the zip entry must be index.mjs
  // (Handler stays index.handler — nodejs24.x resolves the .mjs extension).
  const handlerSrc = path.join(__dirname, '../lambda/token-renew-handler.js');
  if (!fs.existsSync(handlerSrc)) {
    throw new Error(`Token-renew handler not found at ${handlerSrc} — was the package built?`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-renew-'));
  try {
    fs.copyFileSync(handlerSrc, path.join(tmpDir, 'index.mjs'));
    const zipPath = path.join(tmpDir, 'index.zip');
    execFileSync('zip', ['-j', zipPath, 'index.mjs'], { cwd: tmpDir, stdio: 'pipe' });

    const lambdaClient = new LambdaClient({ region: opts.region });
    await lambdaClient.send(new UpdateFunctionCodeCommand({
      FunctionName: lambdaName,
      ZipFile: fs.readFileSync(zipPath),
    }));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  printSuccess(`Rotation scheduled (${scheduleExpression})`);
  return scheduleExpression;
}

/** Read the key id a previous run stored, so this run can retire it. */
async function previousKeyId(
  secretName: string,
  aws: { region: string; profile?: string },
): Promise<{ keyId?: string; serviceAccountId?: string }> {
  try {
    const raw = await getSecretValue(secretName, aws);
    const parsed = JSON.parse(raw) as { keyId?: string; serviceAccountId?: string };
    return { keyId: parsed.keyId, serviceAccountId: parsed.serviceAccountId };
  } catch {
    // No secret yet (first run), or one written before the service-account
    // cutover (no keyId). Either way there is nothing this run can retire.
    return {};
  }
}

/**
 * Registers the `store-token` command with the CLI program.
 *
 * Provisions the org's machine identity — a SERVICE ACCOUNT and one `pb_sa_…`
 * key — and stores the key in AWS Secrets Manager for CDK deployments,
 * CodeBuild's registry credentials, the plugin-lookup Lambda and the event
 * ingestion Lambda (#12 / #N2). Nothing stored is tied to a person's session any
 * more: the account outlives its creator, takes no seat, and every audit row it
 * produces names the account.
 *
 * Because creating an account and issuing its key are step-up gated, this needs
 * the operator's password — `--password`, or the `PLATFORM_PASSWORD` env var
 * (preferred: it keeps the password out of shell history and plan output).
 *
 * By default it ONLY writes the secret. Pass --schedule to also deploy the daily
 * KEY ROTATION stack (a Lambda that replaces the key before it expires).
 *
 * @example
 * ```bash
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --region us-east-1
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --days 90 --region us-east-1
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --schedule --region us-east-1     # + daily rotation
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --scope reporting:ingest --schedule
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --scope registry:push --schedule
 * pipeline-manager infra store-token --dry-run
 * pipeline-manager infra store-token -u admin -p '***' --region us-east-1
 * ```
 */
export function storeToken(program: Command): void {
  withSslOptions(
    withProfileOption(
      withRegionOption(program
        .command('store-token')
        .description('Provision an org service-account key (its own machine identity) and store it in AWS Secrets Manager for CDK deployments')
        .option('-u, --identifier <identifier>', 'Username or email (skips PLATFORM_TOKEN requirement)')
        .option('-p, --password <password>', 'Login password — also used for the step-up every key write requires (prefer PLATFORM_PASSWORD)')
        .option('--days <days>', 'Key lifetime in days (max 365)', '30')
        .option('--scope <scope>', `Provision a least-privilege scoped key instead of the full-privilege platform one. One of: ${Object.keys(SCOPE_CATALOG).join(', ')}`)
        .option('--account <name>', 'Override the service-account name this key is issued on (default: derived from --scope)')
        .option('--dry-run', 'Show what would be provisioned without calling the platform or writing to Secrets Manager', false)),
    )
      .option('--schedule', 'Also deploy the daily key-rotation stack that replaces this key before it expires (off by default)', false)
      .option('--cron <expr>', 'Rotation schedule as a 5-field cron, used with --schedule (default: TOKEN_RENEW_SCHEDULE env or "0 0 * * *"; min every 15 minutes)')
      .option('--json', 'Output result as JSON', false),
  )
    .action(async (options) => {
      const executionId = printCommandHeader('Store Token', undefined, { quiet: options.json });

      try {
        printSslWarning(options.verifySsl);

        const region = resolveAwsRegion(options.region);
        const aws = { region, profile: options.profile as string | undefined };

        const days = validateNumber(options.days, 'days', 1, 365);
        const expiresInSeconds = days * 24 * 60 * 60;

        const scope = options.scope as string | undefined;
        const catalogued = scope ? SCOPE_CATALOG[scope] : undefined;
        if (scope && !catalogued) {
          throw new Error(`Unknown --scope "${scope}". Supported: ${Object.keys(SCOPE_CATALOG).join(', ')}`);
        }
        // Which machine identity this credential belongs to: the scope's own
        // account, or the org's single full-privilege automation account.
        const identity = catalogued ?? PLATFORM_ACCOUNT;
        const accountName = (options.account as string | undefined) ?? identity.account;

        // Step 0: log in first when creds are available and no PLATFORM_TOKEN is
        // set (shared with setup-events). Creds come from --identifier/--password
        // OR the env vars PLATFORM_IDENTIFIER/PLATFORM_PASSWORD — the env path
        // lets callers like `provision --with-events` pass them without putting
        // the password on the command line (where it would show in plans/logs).
        await ensurePlatformToken(options);

        // The password is ALSO the step-up factor for both writes below, so it is
        // required even when PLATFORM_TOKEN is already set. Say that plainly
        // rather than failing three calls later with a 403.
        const password = (options.password as string | undefined) || process.env.PLATFORM_PASSWORD;
        if (!password && !options.dryRun) {
          throw new Error(
            'A password is required: creating a service account and issuing its key are both step-up gated. '
            + 'Set PLATFORM_PASSWORD (preferred) or pass --password.',
          );
        }

        printSection('Provision Service-Account Key');

        const client = await createAuthenticatedClientAsync(options);

        if (options.dryRun) {
          // Dry run stays entirely OFFLINE — it must not create an account or
          // burn a key just to show what it would do.
          const plan = {
            serviceAccount: accountName,
            roles: scope ? 'none (scoped, least privilege)' : 'org admin',
            scope: scope ?? '(none — full platform credential)',
            secretName: process.env.PLATFORM_SECRET_NAME || `${secretNameForOrg('<orgId>', scope ? scopeSecretLeaf(scope) : 'platform')}`,
            region,
            expiresInDays: days,
          };
          if (options.json) {
            console.log(JSON.stringify({ success: true, dryRun: true, ...plan }, null, 2));
          } else {
            console.log('');
            printSection('Dry Run — No Changes Made');
            printKeyValue({
              'Service Account': plan.serviceAccount,
              'Roles': plan.roles,
              'Key Scope': plan.scope,
              'Secret Name': plan.secretName,
              'Region': plan.region,
              'Expires In': `${days} days`,
            });
            printSuccess('Dry run complete — no account, key or secret was created');
          }
          return;
        }

        const keyName = `${accountName}-${new Date().toISOString().slice(0, 10)}`;
        const provisioned = await provisionServiceAccountKey({
          client,
          password: password!,
          accountName,
          description: identity.description,
          roles: scope ? 'none' : 'admin',
          ...(scope ? { scope } : {}),
          expiresInSeconds,
          keyName,
        });

        printSuccess(`Key issued on service account '${accountName}' (expires ${provisioned.expiresAt})`);

        // An explicit PLATFORM_SECRET_NAME still wins (the escape hatch for
        // hand-managed paths); otherwise derive it from the org the platform
        // reported, which works with an opaque access key as PLATFORM_TOKEN —
        // a key carries no org claim to decode.
        const secretName = process.env.PLATFORM_SECRET_NAME
          || secretNameForOrg(provisioned.organizationId, scope ? scopeSecretLeaf(scope) : 'platform');

        auditLog('store-token', {
          executionId,
          secretName,
          days,
          serviceAccount: accountName,
          scope: scope ?? null,
          keyId: provisioned.keyId,
        });

        printInfo('Parameters', {
          secretName,
          region,
          serviceAccount: accountName,
          scope: scope ?? '(none)',
          days,
          expiresIn: `${expiresInSeconds}s`,
        });

        // What this run is REPLACING, read before the write so the old key can be
        // retired after the new one is safely stored.
        const previous = await previousKeyId(secretName, aws);

        // Schema: { username: orgId, password: <pb_sa_ key>, ...metadata }
        // - username/password satisfy CodeBuild's `secretsManagerCredentials`
        //   (HTTP Basic, sent to pipeline-image-registry's /token endpoint, which
        //   exchanges the opaque key like every other service does)
        // - `password` stays the canonical field: the plugin-lookup Lambda, the
        //   events Lambda and `--store-tokens` all read it. Only its VALUE changed,
        //   from a machine-session JWT to an opaque service-account key.
        // - keyId / serviceAccountId are what the rotation Lambda needs to retire
        //   the key it replaces.
        const secretValue = JSON.stringify({
          username: provisioned.organizationId,
          password: provisioned.key,
          platformUrl: client.getBaseUrl(),
          organizationId: provisioned.organizationId,
          serviceAccountId: provisioned.serviceAccountId,
          serviceAccountName: provisioned.serviceAccountName,
          keyId: provisioned.keyId,
          scope: provisioned.scope,
          expiresIn: expiresInSeconds,
          expiresAt: provisioned.expiresAt,
          createdAt: new Date().toISOString(),
        });

        printSection('Store Key');

        const description = `Pipeline Builder service-account key (${accountName}; renew by ${provisioned.expiresAt})`;
        await upsertSecret(secretName, secretValue, description, aws);

        const arn = await getSecretArn(secretName, aws);

        // Retire the credential this run replaced — AFTER the new one is stored,
        // never before. A failure here leaves a superfluous key that expires on
        // its own; doing it in the other order would leave the secret naming a
        // revoked key if the write failed.
        if (previous.keyId && previous.serviceAccountId === provisioned.serviceAccountId) {
          try {
            await revokeServiceAccountKey(
              client, password!, provisioned.organizationId, provisioned.serviceAccountId, previous.keyId,
            );
            printSuccess(`Retired the previous key (${previous.keyId})`);
          } catch (err) {
            printWarning(
              `Stored the new key, but could not revoke the previous one (${previous.keyId}): `
              + `${err instanceof Error ? err.message : String(err)}. It expires on its own; revoke it from `
              + 'Settings → Service accounts if you want it gone now.',
            );
          }
        }

        // Optionally install the once-a-day rotation stack so this key never lapses.
        let scheduleExpression: string | undefined;
        if (options.schedule) {
          const fiveFieldCron = options.cron || process.env.TOKEN_RENEW_SCHEDULE || DEFAULT_RENEW_CRON;
          scheduleExpression = await deployRenewSchedule({
            platformUrl: client.getBaseUrl(),
            secretName,
            days,
            fiveFieldCron,
            region,
            profile: options.profile,
          });
        }

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            secretName,
            secretArn: arn,
            region,
            serviceAccount: accountName,
            serviceAccountId: provisioned.serviceAccountId,
            keyId: provisioned.keyId,
            scope: provisioned.scope,
            expiresInDays: days,
            expiresAt: provisioned.expiresAt,
            schedule: scheduleExpression ?? null,
          }, null, 2));
        } else {
          console.log('');
          printSection('Key Stored');

          printKeyValue({
            'Secret Name': secretName,
            'Secret ARN': arn,
            'Region': region,
            'Service Account': accountName,
            'Key Scope': provisioned.scope ?? '(none — full platform credential)',
            'Key Id': provisioned.keyId,
            'Expires In': `${days} days`,
            'Renew By': provisioned.expiresAt,
            'Auto-Rotate': scheduleExpression ? `✓ ${scheduleExpression}` : 'off (pass --schedule to enable)',
            'Status': '✓ Stored',
          });

          console.log('');
          printSuccess('Key stored. To use with synth/deploy:');
          printInfo(`  export PLATFORM_SECRET_NAME=${secretName}`);
          printInfo('  pipeline-manager pipeline synth --id <pipeline-id> --store-tokens');
          console.log('');
          if (scheduleExpression) {
            printInfo(`Auto-rotation is active (${scheduleExpression}); the secret is replaced before ${provisioned.expiresAt}.`);
          } else {
            printInfo(`Rotate before ${provisioned.expiresAt} with: pipeline-manager infra store-token --days ${days}`);
            printInfo('  (or pass --schedule to install a daily auto-rotation stack)');
          }
        }

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'store-token',
            executionId,
            secretName: process.env.PLATFORM_SECRET_NAME || '(derived from the org)',
          },
        });
      }
    });
}
