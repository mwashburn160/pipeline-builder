// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — re-encrypt every stored secret under the current
 * `SECRET_ENCRYPTION_KEY`.
 *
 * Step 3 of the master-key rotation runbook (docs/runbooks/secret-rotation.md).
 * Run it while BOTH keys are configured (`SECRET_ENCRYPTION_KEY` = new,
 * `SECRET_ENCRYPTION_KEY_PREVIOUS` = outgoing): every read falls back to the
 * previous key when a row is still wrapped under it, every write uses the new
 * one. Once this reports `failures: 0`, the previous key can be removed from the
 * deployment.
 *
 * Run it INSIDE a platform container so it inherits the same env (key material,
 * Mongo URI, per-org KMS flag) the service runs with:
 *
 *   docker compose exec platform node scripts/reencrypt-secrets.js
 *   kubectl exec -n pipeline-builder deploy/platform -- node scripts/reencrypt-secrets.js
 *
 * Exits 0 only when every row was rewritten; exits 1 (printing each failure) if
 * any row could not be decrypted, since that row needs its secret re-entered and
 * the previous key must NOT be dropped yet.
 */

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { bootstrapPerOrgKmsProvider } from '../services/per-org-kms-bootstrap.js';
import { reencryptAllStoredSecrets } from '../services/secret-reencrypt.js';

const logger = createLogger('reencrypt-secrets');

async function main(): Promise<number> {
  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: config.mongodb.serverSelectionTimeoutMs });
  // Same provider the service installs — per-org KMS orgs must be re-wrapped
  // under their own CMK, not the shared master.
  const perOrgKms = bootstrapPerOrgKmsProvider();
  logger.info('Starting re-encryption', {
    perOrgKms,
    previousKeyConfigured: !!process.env.SECRET_ENCRYPTION_KEY_PREVIOUS,
  });

  const summary = await reencryptAllStoredSecrets();
  logger.info('Re-encryption summary', {
    orgsScanned: summary.orgsScanned,
    aiKeysReencrypted: summary.aiKeysReencrypted,
    idpSecretsReencrypted: summary.idpSecretsReencrypted,
    failures: summary.failures.length,
  });
  for (const failure of summary.failures) {
    logger.error('Unreadable secret — re-enter this value before dropping the previous key', failure);
  }
  return summary.failures.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('Re-encryption aborted', { error: err instanceof Error ? err.message : String(err) });
} finally {
  await mongoose.disconnect().catch(() => undefined);
}
process.exit(exitCode);
