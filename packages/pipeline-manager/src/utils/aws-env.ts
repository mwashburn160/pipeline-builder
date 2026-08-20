// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { printWarning } from './output-utils.js';

/**
 * Resolve the AWS region for an SDK/CLI call: explicit `--region` override →
 * `AWS_REGION` → `CDK_DEFAULT_REGION` → `us-east-1`. Single source for the
 * fallback that was previously copy-pasted across every AWS command and the
 * secrets client.
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
