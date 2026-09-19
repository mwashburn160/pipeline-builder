// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — recover an account that has lost EVERY multi-factor
 * credential (#8).
 *
 * This is deliberately NOT an HTTP route. A route that removes someone's second
 * factor is, by construction, a bypass of the second factor: whoever can call it
 * can turn MFA off for any account, which would make the requirement decorative.
 * Requiring database access instead means recovery costs the same as the rest of
 * the platform's trust — if an attacker already has that, MFA is not what is
 * protecting you.
 *
 * What it does, in one pass (see `services/mfa-recovery.ts`):
 *   1. removes every registered passkey and the authenticator-app enrolment
 *      (with its recovery codes) — after this the account has NO factor;
 *   2. bumps `tokenVersion` and clears every refresh-session slot, so every
 *      outstanding access and refresh token stops working immediately,
 *      everywhere;
 *   3. writes an `auth.mfa.operator_reset` audit event naming the operator who
 *      ran it, so the reset is as visible as the enrolment it undoes.
 *
 * It does NOT reopen the bootstrap-admin exception: that closes permanently at
 * the first enrolment and never reopens, even here. If the account's org
 * REQUIRES MFA the person would otherwise be unable to sign in at all — so
 * `--clear-org-policy` turns that requirement off in the same command. Turn it
 * back on once they have re-enrolled.
 *
 * Run it INSIDE a platform container, so it inherits the same env (Mongo URI,
 * key material) the service runs with:
 *
 *   docker compose exec platform node scripts/mfa-recover.js \
 *     --email admin@internal --operator you@example.com
 *   kubectl exec -n pipeline-builder deploy/platform -- \
 *     node scripts/mfa-recover.js --email admin@internal --operator you@example.com --clear-org-policy
 *
 * Exits 0 on success, 1 when the arguments are incomplete or no such account.
 */

import { createLogger } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { recoverMfa } from '../services/mfa-recovery.js';

const logger = createLogger('mfa-recover');

const USAGE = 'Usage: node scripts/mfa-recover.js --email <address> [--operator <who>] [--clear-org-policy]';

/** Parsed `--flag value` / `--flag` arguments. */
function parseArgs(argv: readonly string[]): { email?: string; operator?: string; clearOrgPolicy: boolean } {
  const out: { email?: string; operator?: string; clearOrgPolicy: boolean } = { clearOrgPolicy: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') out.email = argv[++i];
    else if (arg === '--operator') out.operator = argv[++i];
    else if (arg === '--clear-org-policy') out.clearOrgPolicy = true;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    logger.error(USAGE);
    return 1;
  }
  // Who ran it. Not defaulted to something anonymous: an audit row for a factor
  // reset is worth little without a name, and the operator knows their own.
  const operator = args.operator || process.env.MFA_RECOVER_OPERATOR;
  if (!operator) {
    logger.error(`Name the operator running this: --operator <who> (or set MFA_RECOVER_OPERATOR). ${USAGE}`);
    return 1;
  }

  await mongoose.connect(config.mongodb.uri, { serverSelectionTimeoutMS: config.mongodb.serverSelectionTimeoutMs });
  const result = await recoverMfa({ email: args.email, operator, clearOrgPolicy: args.clearOrgPolicy });
  if (!result) {
    logger.error('No account with that email', { email: args.email });
    return 1;
  }

  logger.info('Multi-factor credentials reset', result);
  logger.info(
    'Every session for this account has been ended. Have them sign in with their password and enrol a factor immediately'
    + (result.orgPolicyCleared ? ' — the org\'s "require MFA" policy was turned OFF and must be turned back on afterwards.' : '.'),
  );
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('MFA recovery aborted', { error: err instanceof Error ? err.message : String(err) });
} finally {
  await mongoose.disconnect().catch(() => undefined);
}
process.exit(exitCode);
