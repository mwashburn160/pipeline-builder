// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — re-encrypt the runner signing keys
 * (`pipeline_runner_signing_keys.private_key_enc`) under the current secret
 * encryption, after a `SECRET_ENCRYPTION_KEY` / KMS master rotation (run while
 * both keys are configured) or a per-org KMS config change (`--org <orgId>`).
 * The same job platform's rotation flow calls over
 * `POST /pipelines/internal/runner-signing-keys/reencrypt`.
 *
 * Run it INSIDE a pipeline container so it inherits the service's env:
 *
 *   docker compose exec pipeline node scripts/reencrypt-runner-keys.js [--org <orgId>]
 *   kubectl exec -n pipeline-builder deploy/pipeline -- node scripts/reencrypt-runner-keys.js
 *
 * (The image copies `lib/` to `/app`, so `lib/scripts/…` in the repo is
 * `scripts/…` in the container.) `--org` re-wraps one org's keys; reads try the
 * org's current provider, then the shared one (the org's previous per-org KMS
 * config is not known here — use platform's rotation flow for a CMK change).
 * Safe to re-run: a row already under the current provider counts as done. Exits 0 only when every row
 * was rewritten; 1 (listing each failure by org and kid) otherwise.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { runnerDeps } from '../runners/deps.js';
import { initRunnerKeyEncryption } from '../runners/key-crypto.js';
import { reencryptRunnerKeys } from '../runners/key-reencrypt.js';

const logger = createLogger('reencrypt-runner-keys');

/** `--org <id>` / `--org=<id>`, validated as a 24-hex org id. */
function parseArgs(argv: readonly string[]): { orgId?: string } {
  const i = argv.findIndex((a) => a === '--org' || a.startsWith('--org='));
  if (i < 0) return {};
  const raw = argv[i]!.includes('=') ? argv[i]!.split('=')[1] : argv[i + 1];
  if (!raw || !/^[0-9a-f]{24}$/i.test(raw)) throw new Error('--org needs a 24-character hex organization id');
  return { orgId: raw.toLowerCase() };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!(await initRunnerKeyEncryption())) return 1;
  const result = await reencryptRunnerKeys(runnerDeps(), args);
  logger.info('Runner signing-key re-encryption summary', { scanned: result.scanned, reencrypted: result.reencrypted, failures: result.failures.length });
  for (const f of result.failures) logger.error('Runner signing key not re-encrypted — keep the previous key configured', f);
  return result.failures.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('Runner signing-key re-encryption aborted', { error: errorMessage(err) });
}
process.exit(exitCode);
