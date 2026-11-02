// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { rootCertificates } from 'tls';

/**
 * Trusting a platform that presents a certificate from a PRIVATE CA, without
 * turning verification off.
 *
 * `PLATFORM_CA_BUNDLE` holds the PEM text of the CA (chain). Set where
 * `pipeline-manager pipeline synth/deploy` runs, it is (1) trusted by the CLI's
 * own API client, (2) propagated by the synth into every CodeBuild step's
 * environment — so the self-mutating synth's plugin lookup verifies against it
 * — and (3) into the plugin-lookup Lambda's environment. PEM text rather than a
 * path because none of those three share a filesystem.
 *
 * Dependency-free so the plugin-lookup Lambda can bundle it.
 */
export const PLATFORM_CA_BUNDLE_ENV = 'PLATFORM_CA_BUNDLE';

/** The configured bundle (PEM text), or undefined. Refuses a value that holds no certificate. */
export function platformCaBundle(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pem = env[PLATFORM_CA_BUNDLE_ENV]?.trim();
  if (!pem) return undefined;
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error(`${PLATFORM_CA_BUNDLE_ENV} is set but holds no PEM certificate (expected "-----BEGIN CERTIFICATE-----")`);
  }
  return pem;
}

/**
 * The CA list for an `https.Agent` when a bundle is configured: Node's roots,
 * the `NODE_EXTRA_CA_CERTS` file (an explicit `ca` replaces the default store,
 * which is where Node would otherwise have put it) and the bundle. Undefined
 * when no bundle is set — keep Node's default store untouched then.
 */
export function platformCaList(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const bundle = platformCaBundle(env);
  if (!bundle) return undefined;
  const extra = env.NODE_EXTRA_CA_CERTS ? readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8') : undefined;
  return [...rootCertificates, ...(extra ? [extra] : []), bundle];
}

/**
 * `PLATFORM_TLS_VERIFY` — the one knob for whether the pipeline verifies the
 * platform's certificate. `true` (default) verifies; `false` is for a dev
 * platform on a self-signed certificate with no CA to hand out (prefer
 * {@link PLATFORM_CA_BUNDLE_ENV}, which keeps verification ON).
 *
 * Read at synth time and carried into the pipeline, where `false`:
 *   - appends `--no-verify-ssl` to the self-mutating synth's bootstrap command,
 *   - sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (and this knob) on every CodeBuild
 *     step and on the plugin-lookup Lambda.
 * The CLI still refuses an unverified connection that carries credentials when
 * `NODE_ENV=production`, so the knob cannot quietly reach a production run.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` already in the synth's environment means the
 * same thing — the operator has turned verification off for this process — so
 * it is honoured as `false` rather than silently ignored.
 */
export const PLATFORM_TLS_VERIFY_ENV = 'PLATFORM_TLS_VERIFY';

/** Whether the platform certificate is verified. Refuses a value other than `true`/`false`. */
export function platformTlsVerify(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PLATFORM_TLS_VERIFY_ENV]?.trim().toLowerCase();
  if (raw !== undefined && raw !== '' && raw !== 'true' && raw !== 'false') {
    throw new Error(`${PLATFORM_TLS_VERIFY_ENV} must be "true" or "false" (got "${env[PLATFORM_TLS_VERIFY_ENV]}")`);
  }
  if (raw === 'false') return false;
  return env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
}
