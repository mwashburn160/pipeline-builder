// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — give a locked-out caller their sign-in budget back.
 *
 * "Too many authentication attempts" means a per-IP bucket in the shared
 * rate-limit store is full; "Too many failed sign-in attempts for this account"
 * means the per-account one is. Both drain on their own when the window ends
 * (`AUTH_LIMITER_WINDOW_MS`, `LOGIN_ACCOUNT_LIMITER_WINDOW_MS`). This clears
 * them now, without anyone guessing the store's key format.
 *
 * Run it INSIDE a platform container, so it reaches the same Redis the service
 * uses:
 *
 *   docker compose exec platform node scripts/rate-limit-unlock.js --ip 203.0.113.7
 *   kubectl exec -n pipeline-builder deploy/platform -- \
 *     node scripts/rate-limit-unlock.js --ip 203.0.113.7 --identifier admin@internal
 *
 * `--ip` is the address platform saw (the 429's `RateLimit-*` headers are on the
 * response; the access log has the client IP). `--identifier` is what was typed
 * into the sign-in form. `--dry-run` lists the keys without deleting them.
 *
 * Clearing a bucket only lets the caller TRY again; it grants nothing. Exits 0
 * on success, 1 on bad arguments or when no shared store is configured (an
 * in-memory store lives in each replica — restart it instead).
 */

import { createEnvRedisClient, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { unlockTargets } from '../helpers/rate-limit-unlock.js';

const logger = createLogger('rate-limit-unlock');

const USAGE = 'Usage: node scripts/rate-limit-unlock.js [--ip <address>] [--identifier <email or username>] [--dry-run]';

interface Args { ip?: string; identifier?: string; dryRun: boolean; invalid?: string }

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ip') out.ip = argv[++i];
    else if (arg === '--identifier') out.identifier = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else out.invalid = `Unknown argument: ${arg}`;
  }
  return out;
}

interface DelClient { del(...keys: string[]): Promise<number>; exists(key: string): Promise<number>; quit(): Promise<unknown> }

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.invalid || (!args.ip && !args.identifier)) {
    logger.error(args.invalid ? `${args.invalid}. ${USAGE}` : USAGE);
    return 1;
  }
  const targets = unlockTargets({ ip: args.ip, identifier: args.identifier });

  const redis = createEnvRedisClient<DelClient>('rate-limit-unlock');
  if (!redis) {
    logger.error('No shared rate-limit store is configured (REDIS_* unset): buckets live in each replica\'s memory. Restart platform to clear them.');
    return 1;
  }
  try {
    for (const { bucket, key } of targets) {
      const present = (await redis.exists(key)) === 1;
      if (!args.dryRun && present) await redis.del(key);
      logger.info(`${args.dryRun ? 'Would clear' : present ? 'Cleared' : 'Already empty'}: ${bucket}`, { key });
    }
  } finally {
    await redis.quit().catch(() => undefined);
  }
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('Rate-limit unlock aborted', { error: errorMessage(err) });
}
process.exit(exitCode);
