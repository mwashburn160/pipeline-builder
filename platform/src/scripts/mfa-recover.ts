// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator tool — recover an account that has lost EVERY multi-factor
 * credential, for when NOBODY can sign in to do it over HTTP.
 *
 * The normal path is the two-person reset in the dashboard (an org admin
 * requests it, a different admin or a sysadmin approves it — see
 * `services/mfa-recovery.ts`), or a sysadmin's direct reset. This command is for
 * what those can't reach: the only admin of the only org, or every sysadmin
 * locked out. It runs with DATABASE access, which is the trust it relies on —
 * the operator name it records is self-asserted.
 *
 * What it does, in one pass (the same reset the HTTP paths perform):
 *   1. removes every registered passkey, the authenticator-app enrolment and
 *      the recovery codes — after this the account has NO factor;
 *   2. bumps `tokenVersion` and clears every refresh-session slot, so every
 *      outstanding access and refresh token stops working immediately,
 *      everywhere;
 *   3. grants THIS PERSON a bounded enrolment grace (`--grace-hours`, default
 *      72, max 168): until it passes, their org's "require MFA" policy — own or
 *      inherited from a parent — does not refuse their single-factor sign-in,
 *      so they can sign in and enrol a new factor. The org's policy is never
 *      changed, so nobody else is exempted;
 *   4. writes an `auth.mfa.operator_reset` audit event naming the operator.
 *
 * It does NOT reopen the bootstrap-admin exception: that closes permanently at
 * the first enrolment and never reopens, even here.
 *
 * Run it INSIDE a platform container, so it inherits the same env (Mongo URI,
 * key material) the service runs with:
 *
 *   docker compose exec platform node scripts/mfa-recover.js \
 *     --email admin@internal --operator you@example.com
 *   kubectl exec -n pipeline-builder deploy/platform -- \
 *     node scripts/mfa-recover.js --email admin@internal --operator you@example.com --grace-hours 24
 *
 * Exits 0 on success, 1 when the arguments are incomplete or no such account.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { MFA_RESET_GRACE_MAX_HOURS } from '../helpers/mfa-policy.js';
import { recoverMfa } from '../services/mfa-recovery.js';

const logger = createLogger('mfa-recover');

const USAGE = 'Usage: node scripts/mfa-recover.js --email <address> [--operator <who>] [--grace-hours <1-168>]';

/** Parsed `--flag value` arguments. */
function parseArgs(argv: readonly string[]): { email?: string; operator?: string; graceHours?: number; invalid?: string } {
  const out: { email?: string; operator?: string; graceHours?: number; invalid?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') {out.email = argv[++i];} else if (arg === '--operator') {out.operator = argv[++i];} else if (arg === '--grace-hours') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MFA_RESET_GRACE_MAX_HOURS) out.invalid = `--grace-hours must be an integer from 1 to ${MFA_RESET_GRACE_MAX_HOURS}`;
      else out.graceHours = n;
    } else {out.invalid = `Unknown argument: ${arg}`;}
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.invalid || !args.email) {
    logger.error(args.invalid ? `${args.invalid}. ${USAGE}` : USAGE);
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
  const result = await recoverMfa({ email: args.email, operator, graceHours: args.graceHours });
  if (!result) {
    logger.error('No account with that email', { email: args.email });
    return 1;
  }

  logger.info('Multi-factor credentials reset', result);
  logger.info(
    'Every session for this account has been ended. Have them sign in with their password and enrol a factor '
    + `before ${result.graceUntil.toISOString()} — after that their org's MFA policy applies to them again.`,
  );
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  logger.error('MFA recovery aborted', { error: errorMessage(err) });
} finally {
  await mongoose.disconnect().catch(() => undefined);
}
process.exit(exitCode);
