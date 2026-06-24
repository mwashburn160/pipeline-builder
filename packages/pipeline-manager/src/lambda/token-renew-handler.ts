// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lambda handler that re-mints the platform JWT in Secrets Manager so it never
 * lapses. Deployed + scheduled (once a day) by `pipeline-manager store-token
 * --schedule`. Rather than re-implementing the token flow, it is a thin
 * orchestrator that reuses the tested CLI — each run:
 *
 *   1. Point the `@pipeline-builder` npm scope at public npm.
 *   2. Download `@pipeline-builder/pipeline-manager` from npm into /tmp.
 *   3. Read the current platform JWT from the secret.
 *   4. Run `pipeline-manager store-token`, which mints a fresh long-lived token
 *      via /api/user/generate-token and writes it back to the same secret.
 *
 * `/tmp` is the only writable path in Lambda, so npm's HOME/cache/prefix all live
 * there. store-token does NOT deploy the renewal stack by default (no --schedule),
 * so the renewal run never redeploys/recurses into its own stack.
 *
 * Env: PLATFORM_SECRET_NAME, PLATFORM_BASE_URL, RENEW_DAYS (default 30),
 *      PIPELINE_MANAGER_VERSION (default "latest"), PLATFORM_VERIFY_SSL ("false"
 *      to disable TLS verification).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const PM_PACKAGE = '@pipeline-builder/pipeline-manager';
const TMP = '/tmp';
const PM_PREFIX = `${TMP}/pm`;
const NPM_CACHE = `${TMP}/.npm`;
const NPMRC = `${TMP}/.npmrc`;
const CLI = `${PM_PREFIX}/node_modules/${PM_PACKAGE}/dist/cli.js`;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} environment variable is required`);
  return v;
}

export const handler = async (): Promise<void> => {
  const secretName = required('PLATFORM_SECRET_NAME');
  const platformUrl = required('PLATFORM_BASE_URL').replace(/\/$/, '');
  const days = process.env.RENEW_DAYS || '30';
  const version = process.env.PIPELINE_MANAGER_VERSION || 'latest';
  const region = process.env.AWS_REGION || 'us-east-1';

  // npm in Lambda can only write under /tmp; HOME/cache/userconfig point there.
  const npmEnv = { ...process.env, HOME: TMP, npm_config_cache: NPM_CACHE };

  // 1. Scope config: resolve @pipeline-builder from public npm regardless of any
  //    inherited registry. Written as a userconfig file (env mapping of scoped
  //    keys is unreliable).
  writeFileSync(NPMRC, '@pipeline-builder:registry=https://registry.npmjs.org/\n');

  // 2. Download pipeline-manager into /tmp.
  mkdirSync(PM_PREFIX, { recursive: true });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'INFO', msg: 'installing pipeline-manager', package: `${PM_PACKAGE}@${version}` }));
  execFileSync(
    'npm',
    ['install', '--prefix', PM_PREFIX, '--no-audit', '--no-fund', '--userconfig', NPMRC, `${PM_PACKAGE}@${version}`],
    { env: npmEnv, stdio: 'inherit' },
  );

  // 3. Read the current platform JWT — it authenticates the renewal request.
  const sm = new SecretsManagerClient({ region });
  const current = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!current.SecretString) throw new Error(`Secret "${secretName}" is empty`);
  const jwt = (JSON.parse(current.SecretString) as { password?: string }).password;
  if (!jwt) throw new Error(`Secret "${secretName}" missing password (JWT)`);

  // 4. Run store-token (without --schedule, the default) so it ONLY re-mints and
  //    writes the secret — it must not redeploy this stack (would recurse). The
  //    write uses the Lambda role's creds.
  // store-token no longer takes --secret-name; it reads PLATFORM_SECRET_NAME from
  // the environment (else derives it from the token's org).
  const args = ['store-token', '--region', region, '--days', days];
  if (process.env.PLATFORM_VERIFY_SSL === 'false') args.push('--no-verify-ssl');

  execFileSync('node', [CLI, ...args], {
    env: { ...npmEnv, PLATFORM_TOKEN: jwt, PLATFORM_BASE_URL: platformUrl, PLATFORM_SECRET_NAME: secretName },
    stdio: 'inherit',
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'INFO', msg: 'platform token renewed', secretName }));
};
