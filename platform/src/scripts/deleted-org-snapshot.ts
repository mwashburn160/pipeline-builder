// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — write a deleted org's recovery snapshot (the full export
 * captured at soft-delete time) to stdout as JSON, so it can be handed back to
 * the customer or used to rebuild after a mistaken deletion.
 *
 * The snapshot is stored chunked (services/deleted-org-snapshot-store.ts) and is
 * verified against its recorded size and SHA-256 before anything is printed.
 * It exists only until the org's purge time (30 days by default) — after that
 * the TTL index has removed it, and this command says so.
 *
 * Run it INSIDE a platform container, so it inherits the service's Mongo URI:
 *
 *   docker compose exec -T platform node scripts/deleted-org-snapshot.js --org <orgId> > acme.json
 *   kubectl exec -n pipeline-builder deploy/platform -- \
 *     node scripts/deleted-org-snapshot.js --org <orgId> > acme.json
 *
 * `--snapshot <id>` selects one snapshot; otherwise the org's newest is used.
 * Exits 0 on success, 1 on bad arguments, no snapshot, or a corrupt one.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { latestSnapshotIdForOrg, readDeletedOrgSnapshot } from '../services/deleted-org-snapshot-store.js';

const logger = createLogger('deleted-org-snapshot');

const USAGE = 'Usage: node scripts/deleted-org-snapshot.js (--org <orgId> | --snapshot <snapshotId>)';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let org: string | undefined;
  let snapshot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') {org = argv[++i];} else if (argv[i] === '--snapshot') {snapshot = argv[++i];} else {
      logger.error(`Unknown argument: ${argv[i]}. ${USAGE}`);
      return 1;
    }
  }
  if (!org && !snapshot) {
    logger.error(USAGE);
    return 1;
  }

  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: config.mongodb.serverSelectionTimeoutMs });
  const id = snapshot ?? await latestSnapshotIdForOrg(org!);
  const found = id ? await readDeletedOrgSnapshot(id) : null;
  if (!found) {
    logger.error('No snapshot found (never taken, or past its retention and removed)', { org, snapshot });
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ header: found.header, snapshot: found.snapshot })}\n`);
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('Snapshot read aborted', { error: errorMessage(err) });
} finally {
  await mongoose.disconnect().catch(() => undefined);
}
process.exit(exitCode);
