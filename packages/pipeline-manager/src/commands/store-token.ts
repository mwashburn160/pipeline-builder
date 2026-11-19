// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import * as os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { LambdaClient, UpdateFunctionCodeCommand } from '@aws-sdk/client-lambda';
import { AUTOMATION_ACCOUNT_BUNDLES, errorMessage, SEED_BUNDLES } from '@pipeline-builder/api-core';
import type { SeedBundleId, TokenScope } from '@pipeline-builder/api-core';
import { PIPELINE_REGISTRATION_CAPABILITY } from '@pipeline-builder/pipeline-core';
import { Command } from 'commander';
import { APP_VERSION, TIMEOUTS, validateNumber } from '../config/cli.constants.js';
import type { ApiClient } from '../utils/api-client.js';
import { auditLog } from '../utils/audit-log.js';
import { resolveAwsRegion } from '../utils/aws-env.js';
import { upsertSecret, getSecretArn, getSecretValue } from '../utils/aws-secrets.js';
import { createAuthenticatedClientAsync, printCommandHeader, printSslWarning, withProfileOption, withRegionOption, withSslOptions } from '../utils/command-utils.js';
import { toEventBridgeCron } from '../utils/cron.js';
import { beginDeviceApproval, pollForDeviceToken } from '../utils/device-auth.js';
import { ERROR_CODES, handleError } from '../utils/error-handler.js';
import { printInfo, printKeyValue, printSection, printSuccess, printWarning } from '../utils/output-utils.js';
import { ensurePlatformToken, scopeSecretLeaf, secretNameForOrg, siblingSecretName } from '../utils/platform-secret.js';
import {
  adoptServiceAccountKey, browserStepUp, passwordStepUp, provisionServiceAccountKey, revokeSiblingKey, totpStepUp,
  type ProvisionedKey, type StepUpProvider,
} from '../utils/service-account.js';
import { platformHttpsAgent } from '../utils/tls.js';

// ESM has no __dirname; derive it from this module's URL.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RENEW_STACK_NAME = 'pipeline-builder-token-renew';
// CFN-managed Lambda function name — keep in sync with token-renew-stack.json.
const RENEW_LAMBDA_NAME = 'pipeline-builder-token-renew';
// Default 5-field cron (daily at midnight) when neither --cron nor TOKEN_RENEW_SCHEDULE is set.
const DEFAULT_RENEW_CRON = '0 0 * * *';

/** One least-privilege machine identity `store-token` can provision. */
interface CatalogEntry {
  /** The service account the key is issued on. */
  account: keyof typeof AUTOMATION_ACCOUNT_BUNDLES;
  description: string;
  /**
   * A capability SCOPE stamped on the KEY: the exchanged token carries this one
   * scope and no permissions at all, so the account needs no Role.
   */
  keyScope?: TokenScope;
}

/**
 * The least-privilege credentials `--scope` selects, and what each one is FOR.
 *
 * Two shapes, one flag:
 *  - a KEY scope (`reporting:ingest`, `registry:push`): the key exchanges to a
 *    token carrying only that scope — no permissions, no admin flags — for a
 *    route that checks the scope itself;
 *  - a CAPABILITY (`pipeline_registry:write`): an ordinary permission, so the key
 *    is unscoped and its account holds the one built-in Role carrying it
 *    (Pipeline Registration). Used where the route is gated by
 *    `requirePermission`, which people satisfy through their own Roles.
 *
 * Which Role each account holds comes from api-core's
 * `AUTOMATION_ACCOUNT_BUNDLES` — the same table the platform's startup backfill
 * moves existing accounts with.
 */
const SCOPE_CATALOG: Record<string, CatalogEntry> = {
  'reporting:ingest': {
    account: 'reporting-ingest',
    description: 'AWS pipeline-event ingestion and step security-report uploads (the reporting:ingest scope)',
    keyScope: 'reporting:ingest',
  },
  'registry:push': {
    account: 'registry-push',
    description: 'CI image pushes and pulls into this org’s registry namespace (CodeBuild → /token)',
    keyScope: 'registry:push',
  },
  [PIPELINE_REGISTRATION_CAPABILITY]: {
    account: 'pipeline-register',
    description: 'The CodeBuild synth registering its step manifest (POST/DELETE /pipelines/registry)',
  },
};

/** The `--scope` values `store-token` accepts (each stored under its own secret leaf). */
export const STORE_TOKEN_SCOPES: readonly string[] = Object.keys(SCOPE_CATALOG);

/**
 * The account behind the default (no `--scope`) credential: the CodeBuild synth,
 * `pipeline deploy --store-tokens` and the run-time vulnerability check. It holds the Pipeline Automation Role — pipeline and
 * plugin reads — and nothing more; it is no longer an org admin.
 */
const PLATFORM_ACCOUNT: CatalogEntry = {
  account: 'platform-automation',
  description: 'Stored platform credential for CDK synth/deploy, plugin lookup and the run-time vulnerability check',
};

/** The built-in Role (seed bundle) a NEW account for `entry` is granted, if any. */
function roleFor(entry: CatalogEntry): SeedBundleId | undefined {
  return AUTOMATION_ACCOUNT_BUNDLES[entry.account] ?? undefined;
}

/**
 * Deploy (or update) the once-a-day KEY ROTATION stack: a scheduled Lambda that
 * replaces the service-account key in this secret before it expires. Mirrors
 * setup-events — `aws cloudformation deploy` for the infra, then a direct
 * UpdateFunctionCode with the rotator handler compiled alongside this CLI (see
 * src/lambda/token-renew-handler.ts).
 */
async function deployRenewSchedule(opts: {
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
    keyLifetimeDays: opts.days,
  });

  // Step 1: infra (Lambda gets placeholder code on first create).
  const templatePath = path.join(__dirname, '../templates/token-renew-stack.json');
  const cfnArgs = [
    'cloudformation', 'deploy',
    '--stack-name', stackName,
    '--template-file', templatePath,
    '--parameter-overrides',
    `PlatformSecretName=${opts.secretName}`,
    `KeyLifetimeDays=${opts.days}`,
    `ScheduleExpression=${scheduleExpression}`,
    `NameSuffix=${nameSuffix}`,
    // Recorded for provenance only — the rotator does not install the CLI at
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
  // (Handler stays index.handler — nodejs26.x resolves the .mjs extension).
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
 * The key for `--from-key`: a file path, or `-` for stdin. Deliberately never
 * the key itself as the flag's value — that would put it in shell history and
 * `ps` output.
 */
export function readKeyInput(source: string, readFile: (p: string | number) => string = (p) => fs.readFileSync(p, 'utf8')): string {
  const raw = source === '-' ? readFile(0) : readFile(source);
  const key = raw.trim();
  if (!key) throw new Error(`--from-key ${source === '-' ? '(stdin)' : source} is empty — expected a pb_sa_… key.`);
  if (/\s/.test(key)) throw new Error('--from-key must contain exactly one key and nothing else.');
  return key;
}

/** How `store-token` re-verifies the operator for the key writes. */
export type StepUpMethod = 'password' | 'totp' | 'browser';

/**
 * Pick the step-up method. `auto` (the default): the password when one was
 * given (CI, `provision`), otherwise — in a terminal — a browser approval, which
 * works for EVERY account (password, passkey, authenticator app, SSO / social
 * re-sign-in: the browser offers whatever the account has). Without a terminal
 * and without a password there is nobody to approve, so it says how to proceed
 * rather than hanging.
 */
export function chooseStepUp(opts: { requested?: string; password?: string; interactive: boolean }): StepUpMethod {
  const requested = (opts.requested ?? 'auto').toLowerCase();
  if (!['auto', 'password', 'totp', 'browser'].includes(requested)) {
    throw new Error(`Unknown --step-up "${opts.requested}". One of: auto, password, totp, browser.`);
  }
  if (requested === 'password' || (requested === 'auto' && opts.password)) {
    if (!opts.password) {
      throw new Error('--step-up password needs the password: set PLATFORM_PASSWORD (preferred) or pass --password.');
    }
    return 'password';
  }
  if (!opts.interactive) {
    throw new Error(
      'Creating a service account and issuing its key are step-up gated, and this is not an interactive terminal. '
      + 'Set PLATFORM_PASSWORD (preferred) or pass --password; or, for an account with no password, issue the key '
      + 'on the Service accounts page and pass it with --from-key -.',
    );
  }
  return requested === 'totp' ? 'totp' : 'browser';
}

/**
 * The {@link StepUpProvider} for a chosen method — shared by every command whose
 * platform writes are step-up gated (`store-token`, `setup-runner`).
 */
export function buildStepUpProvider(
  method: StepUpMethod,
  client: ApiClient,
  opts: { password?: string; verifySsl?: boolean; browser?: boolean; purpose: string },
): StepUpProvider {
  if (method === 'password') return passwordStepUp(client, opts.password!);
  if (method === 'totp') return totpStepUp(client, () => askLine('Authenticator code: '));
  return browserStepUp(async () => {
    const transport = { url: client.getBaseUrl(), httpsAgent: platformHttpsAgent(opts.verifySsl), timeout: TIMEOUTS.HTTP_REQUEST };
    printInfo(`Approve in your browser to ${opts.purpose} (passkey, SSO, Google/GitHub or password — whatever your account uses).`);
    const code = await beginDeviceApproval(transport, { quiet: false, browser: opts.browser, verifySsl: opts.verifySsl, stepUp: true });
    return (await pollForDeviceToken(transport, code)).step_up_token;
  });
}

/** Ask one line on the terminal (the authenticator code). */
async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** What a dry run reports it WOULD provision. */
export interface StoreTokenPlan {
  serviceAccount: string;
  roles: string;
  scope: string;
  secretName: string;
  region: string;
  expiresInDays: number;
}

/** Print the dry-run plan (JSON or human). Stays entirely offline. */
export function printDryRunPlan(plan: StoreTokenPlan, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ success: true, dryRun: true, ...plan }, null, 2));
    return;
  }
  console.log('');
  printSection('Dry Run — No Changes Made');
  printKeyValue({
    'Service Account': plan.serviceAccount,
    'Roles': plan.roles,
    'Key Scope': plan.scope,
    'Secret Name': plan.secretName,
    'Region': plan.region,
    'Expires In': `${plan.expiresInDays} days`,
  });
  printSuccess('Dry run complete — no account, key or secret was created');
}

/**
 * The Secrets Manager payload: `{ username: orgId, password: <pb_sa_ key>, ...metadata }`.
 * - username/password satisfy CodeBuild's `secretsManagerCredentials` (HTTP
 *   Basic, sent to pipeline-image-registry's /token endpoint, which exchanges
 *   the opaque key like every other service does).
 * - `password` is the canonical field: the events Lambda and `--store-tokens`
 *   both read it.
 * - keyId / serviceAccountId are what the rotation Lambda needs to retire the
 *   key it replaces.
 */
export function buildSecretValue(provisioned: ProvisionedKey, platformUrl: string, expiresInSeconds: number): string {
  return JSON.stringify({
    username: provisioned.organizationId,
    password: provisioned.key,
    platformUrl,
    organizationId: provisioned.organizationId,
    serviceAccountId: provisioned.serviceAccountId,
    serviceAccountName: provisioned.serviceAccountName,
    keyId: provisioned.keyId,
    scope: provisioned.scope,
    expiresIn: expiresInSeconds,
    expiresAt: provisioned.expiresAt,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Retire the credential this run replaced — AFTER the new one is stored, never
 * before. A failure here leaves a superfluous key that expires on its own;
 * doing it in the other order would leave the secret naming a revoked key if
 * the write failed.
 */
export async function retirePreviousKey(
  client: ApiClient,
  provisioned: ProvisionedKey,
  previous: { keyId?: string; serviceAccountId?: string },
): Promise<void> {
  if (!previous.keyId || previous.serviceAccountId !== provisioned.serviceAccountId) return;
  if (previous.keyId === provisioned.keyId) return;
  try {
    // The NEW key retires its sibling (`/auth/key/revoke`) — the key is the
    // authority, so this needs no step-up and works for an account with no
    // password, the same way the rotation Lambda retires its predecessor.
    await revokeSiblingKey(client, provisioned.key, previous.keyId);
    printSuccess(`Retired the previous key (${previous.keyId})`);
  } catch (err) {
    printWarning(
      `Stored the new key, but could not revoke the previous one (${previous.keyId}): `
      + `${errorMessage(err)}. It expires on its own; revoke it from `
      + 'Settings → Service accounts if you want it gone now.',
    );
  }
}

/** Print the stored key's summary (JSON or human) plus the next steps. */
export function printStoredKey(r: {
  json: boolean;
  secretName: string;
  arn: string | undefined;
  region: string;
  accountName: string;
  provisioned: ProvisionedKey;
  days: number;
  scheduleExpression: string | undefined;
}): void {
  const { secretName, arn, region, accountName, provisioned, days, scheduleExpression } = r;
  if (r.json) {
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
      'Key Scope': provisioned.scope ?? '(none — the account\'s Role is its authority)',
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
      printInfo(`Rotate before ${provisioned.expiresAt} with: pipeline-manager infra store-token --expires-days ${days}`);
      printInfo('  (or pass --schedule to install a daily auto-rotation stack)');
    }
  }
}

/**
 * Registers the `store-token` command with the CLI program.
 *
 * Provisions the org's machine identity — a SERVICE ACCOUNT and one `pb_sa_…`
 * key — and stores the key in AWS Secrets Manager for CDK deployments,
 * CodeBuild's registry credentials and the event ingestion Lambda. Nothing stored is tied to a person's session any
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
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --expires-days 90 --region us-east-1
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --schedule --region us-east-1     # + daily rotation
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --scope reporting:ingest --schedule
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --scope registry:push --schedule
 * PLATFORM_PASSWORD=*** pipeline-manager infra store-token --scope pipeline_registry:write --schedule
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
        .option('--step-up <method>', 'How to re-verify for the key writes: auto (password if given, else browser approval), password, totp (authenticator code), browser (passkey / SSO / Google / GitHub — any account)', 'auto')
        .option('--no-browser', 'With browser step-up: print the approval URL instead of opening a browser')
        .option('--expires-days <days>', 'Key lifetime in days (max 365)', '30')
        .option('--scope <scope>', `Provision a single-purpose credential instead of the platform one. One of: ${Object.keys(SCOPE_CATALOG).join(', ')}`)
        .option('--account <name>', 'Override the service-account name this key is issued on (default: derived from --scope)')
        .option('--from-key <file>', 'Store a key you issued in the web UI instead of issuing one here — a file path, or - for stdin. No password needed: for accounts that sign in with Google/GitHub/SSO or a passkey. The key is checked (account + scope), replaced with a fresh one, and the pasted one retired.')
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

        const days = validateNumber(options.expiresDays, 'expires-days', 1, 365);
        const expiresInSeconds = days * 24 * 60 * 60;

        const scope = options.scope as string | undefined;
        const catalogued = scope ? SCOPE_CATALOG[scope] : undefined;
        if (scope && !catalogued) {
          throw new Error(`Unknown --scope "${scope}". Supported: ${Object.keys(SCOPE_CATALOG).join(', ')}`);
        }
        // Which machine identity this credential belongs to: the scope's own
        // account, or the org's platform automation account.
        const identity = catalogued ?? PLATFORM_ACCOUNT;
        const accountName = (options.account as string | undefined) ?? identity.account;
        const role = roleFor(identity);
        const keyScope = identity.keyScope;
        const secretLeaf = scope ? scopeSecretLeaf(scope) : 'platform';
        // An explicit PLATFORM_SECRET_NAME (the escape hatch for hand-managed
        // paths) names the PLATFORM secret — the one this command tells the
        // operator to export — so a scoped key goes to its sibling, never into
        // it. Otherwise the path is derived from the org the platform reports,
        // which works with an opaque access key as PLATFORM_TOKEN (a key carries
        // no org claim to decode).
        const explicitSecretName = process.env.PLATFORM_SECRET_NAME;
        const secretNameFor = (orgId: string): string => (explicitSecretName
          ? siblingSecretName(explicitSecretName, secretLeaf)
          : secretNameForOrg(orgId, secretLeaf));

        if (options.dryRun) {
          // Dry run stays entirely OFFLINE — no login, no account, no key, no
          // secret: it only reports what it would do.
          printDryRunPlan({
            serviceAccount: accountName,
            roles: role ? SEED_BUNDLES[role].name : 'none (scoped key, least privilege)',
            scope: keyScope ?? '(none — the account\'s Role is its authority)',
            secretName: secretNameFor('<orgId>'),
            region,
            expiresInDays: days,
          }, !!options.json);
          return;
        }

        // Step 0: log in first when creds are available and no PLATFORM_TOKEN is
        // set (shared with setup-events). Creds come from --identifier/--password
        // OR the env vars PLATFORM_IDENTIFIER/PLATFORM_PASSWORD — the env path
        // lets callers like `provision --with-events` pass them without putting
        // the password on the command line (where it would show in plans/logs).
        await ensurePlatformToken(options);

        const keyName = `${accountName}-${new Date().toISOString().slice(0, 10)}`;
        const fromKey = options.fromKey as string | undefined;
        let provisioned: ProvisionedKey;
        let client: ApiClient;
        if (fromKey) {
          // ADOPT a key issued in the web UI. Every call is authorised by the key
          // itself or is a read on the operator's session — no step-up, so no
          // password (see adoptServiceAccountKey).
          const rawKey = readKeyInput(fromKey);
          printSection('Adopt Service-Account Key');
          client = await createAuthenticatedClientAsync(options);
          provisioned = await adoptServiceAccountKey({
            client, rawKey, accountName, ...(keyScope ? { scope: keyScope } : {}), expiresInSeconds, keyName,
          });
        } else {
          // The key writes are step-up gated even when PLATFORM_TOKEN is set. Decide
          // HOW before any call, so a CI run without a password fails here with
          // the fix rather than three calls later with a 401.
          const password = (options.password as string | undefined) || process.env.PLATFORM_PASSWORD;
          const method = chooseStepUp({
            requested: options.stepUp as string | undefined,
            password,
            interactive: !!process.stdin.isTTY && !options.json,
          });
          printSection('Provision Service-Account Key');
          client = await createAuthenticatedClientAsync(options);
          const stepUp = buildStepUpProvider(method, client, {
            password,
            verifySsl: options.verifySsl,
            browser: options.browser,
            purpose: `issue the '${accountName}' key`,
          });
          provisioned = await provisionServiceAccountKey({
            client,
            stepUp,
            accountName,
            description: identity.description,
            ...(role ? { role } : {}),
            ...(keyScope ? { scope: keyScope } : {}),
            expiresInSeconds,
            keyName,
          });
        }

        printSuccess(`Key ${fromKey ? 'adopted' : 'issued'} on service account '${accountName}' (expires ${provisioned.expiresAt})`);

        const secretName = secretNameFor(provisioned.organizationId);

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

        const secretValue = buildSecretValue(provisioned, client.getBaseUrl(), expiresInSeconds);

        printSection('Store Key');

        const description = `Pipeline Builder service-account key (${accountName}; renew by ${provisioned.expiresAt})`;
        await upsertSecret(secretName, secretValue, description, aws);

        const arn = await getSecretArn(secretName, aws);

        await retirePreviousKey(client, provisioned, previous);

        // Optionally install the once-a-day rotation stack so this key never lapses.
        let scheduleExpression: string | undefined;
        if (options.schedule) {
          const fiveFieldCron = options.cron || process.env.TOKEN_RENEW_SCHEDULE || DEFAULT_RENEW_CRON;
          scheduleExpression = await deployRenewSchedule({
            secretName,
            days,
            fiveFieldCron,
            region,
            profile: options.profile,
          });
        }

        printStoredKey({
          json: !!options.json,
          secretName,
          arn,
          region,
          accountName,
          provisioned,
          days,
          scheduleExpression,
        });

      } catch (error) {
        handleError(error, ERROR_CODES.API_REQUEST, {
          debug: program.opts().debug,
          exit: true,
          context: {
            command: 'store-token',
            executionId,
            secretName: process.env.PLATFORM_SECRET_NAME
              ? siblingSecretName(process.env.PLATFORM_SECRET_NAME, options.scope ? scopeSecretLeaf(String(options.scope)) : 'platform')
              : '(derived from the org)',
          },
        });
      }
    });
}
