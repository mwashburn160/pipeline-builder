// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { printWarning } from './output-utils.js';

/**
 * Resolve the AWS region for an SDK/CLI call: explicit `--region` override →
 * `AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`. Single source for the
 * fallback used by every AWS command and the secrets client.
 */
export function resolveAwsRegion(override?: string): string {
  return override || process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'us-east-1';
}

/**
 * Apply a `--profile` to the environment so the AWS SDK's default provider chain
 * (which every client we build with `credentials` unset reads) selects that shared
 * profile. **Call BEFORE constructing any SDK client**, or `--profile` is silently
 * dropped and the client hits the default account — a silent split-brain when the
 * accompanying CLI/`cdk` call *did* honor `--profile`.
 *
 * Precedence: ambient env credentials (`AWS_ACCESS_KEY_ID`) and an inherited
 * `AWS_PROFILE` always win — we never clobber the caller's environment. An
 * explicit non-default `--profile` that's overridden by ambient creds is surfaced
 * as a warning so a silently-ignored flag isn't a surprise.
 */
export function applyAwsProfile(profile?: string): void {
  if (profile && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    process.env.AWS_PROFILE = profile;
  } else if (profile && profile !== 'default') {
    printWarning(
      `--profile ${profile} ignored: existing AWS credentials in the environment ` +
      `(${process.env.AWS_ACCESS_KEY_ID ? 'AWS_ACCESS_KEY_ID' : 'AWS_PROFILE'}) take precedence.`,
    );
  }
}

/** Reads the region the AWS SDK would use for `profile` (env, then the shared config). */
export type ProfileRegionReader = (profile?: string) => Promise<string | undefined>;

/** The SDK's own region chain for a profile — `region` in ~/.aws/config included. */
export const sdkProfileRegion: ProfileRegionReader = async (profile) => {
  try {
    const { STSClient } = await import('@aws-sdk/client-sts');
    const client = new STSClient(profile ? { profile } : {});
    try {
      return (await client.config.region()) || undefined;
    } finally {
      client.destroy();
    }
  } catch {
    return undefined; // no region configured anywhere
  }
};

/**
 * The ONE region a deploy uses — for `cdk deploy` AND for the platform's
 * registry row that Re-run / Stop later call CodePipeline in.
 *
 * {@link resolveAwsRegion} alone was wrong for this: it never reads the shared
 * config, so with the region set only in `~/.aws/config` (or `--region` given
 * without `AWS_REGION`) CDK deployed to the profile's region while the registry
 * recorded `us-east-1` — and every Re-run answered "Pipeline not found in AWS"
 * for a pipeline that was running fine. Precedence: `--region` → `AWS_REGION` →
 * `AWS_DEFAULT_REGION` → `CDK_DEFAULT_REGION` → the profile's configured region
 * → `us-east-1`. The caller then hands the result to `cdk deploy` explicitly,
 * so CDK cannot pick a different one.
 */
export async function resolveDeployRegion(
  override?: string,
  profile?: string,
  readProfileRegion: ProfileRegionReader = sdkProfileRegion,
): Promise<string> {
  return override
    || process.env.AWS_REGION
    || process.env.AWS_DEFAULT_REGION
    || process.env.CDK_DEFAULT_REGION
    || (await readProfileRegion(profile))
    || 'us-east-1';
}
