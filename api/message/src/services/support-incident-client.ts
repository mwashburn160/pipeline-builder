// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The INCIDENT door into a support case.
 *
 * Support is sold per contact, and an org holding zero contacts cannot open a
 * case against a seat. A one-time incident is the second door — a concession
 * granted by the vendor, never sold — and `SupportEntitlement.canOpenCase`
 * documents the case-open path as a DISJUNCTION: contact seat OR incident. This
 * module is the second half of that, which for a long time existed only in the
 * comment.
 *
 * WHY A LIVE CALL AND NOT A SYNCED BALANCE. The balance could have been pushed
 * onto the root org beside `seats` and `supportContacts`, the shape those two
 * use. It is worse here for two reasons that compound: the balance changes on
 * every grant AND every spend, so a synced copy is stale exactly when it
 * matters; and knowing the number is useless without then spending it, so the
 * service would read a stale figure and still have to write. ONE atomic
 * "consume if you can" removes the race and the staleness together.
 *
 * It costs a hop only on the RARE path. The caller asks only when the org has
 * no contact seat to open against, so an ordinary support send from an ordinary
 * customer never touches this.
 */

import {
  BILLING_INTERNAL,
  SYSTEM_ORG_ID,
  callInternal,
  createLogger,
  errorMessage,
  getServiceAuthHeader,
  InternalHttpClient,
  type ContractResponse,
  type InternalCallResult,
  type InternalCallInput,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';
import { config } from '../config.js';

const logger = createLogger('support-incident-client');

/** Bounded like the entitlement read: a slow billing must not hang a send. */
const TIMEOUT_MS = config.support.incidentTimeoutMs;

const { consumeSupportIncident: CONSUME, refundSupportIncident: REFUND } = BILLING_INTERNAL;

/** An incident reply is a couple of fields; anything larger is not an answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POST one incident write to billing through the shared client (pooled sockets,
 * per-target circuit breaker, bounded body). Automatic retries are OFF on both
 * axes: the consume loop below owns retrying (with the SAME key, and with its
 * own accounting of an unknown outcome), and a 429 must stay a definite
 * refusal rather than be re-sent behind the caller's back.
 */
function postToBilling<C extends typeof CONSUME | typeof REFUND>(
  contract: C, orgId: string, key: string,
): Promise<InternalCallResult<ContractResponse<C>>> {
  const { billingHost, billingPort } = Config.get('server').services;
  const client = new InternalHttpClient({ host: billingHost, port: billingPort, timeout: TIMEOUT_MS }, { maxResponseBytes: MAX_RESPONSE_BYTES });
  return callInternal(client, contract, {
    params: { orgId },
    // Both contracts take the same `{ idempotencyKey }` body.
    body: { idempotencyKey: key } as InternalCallInput<C>['body'],
    options: {
      headers: { Authorization: authHeader() },
      maxRetries: 0,
      maxRateLimitRetries: 0,
    },
  });
}

/** Service principal, least privilege — a write, but on the CALLER's behalf. */
function authHeader(): string {
  return getServiceAuthHeader({ serviceName: 'message', orgId: SYSTEM_ORG_ID, role: 'member' });
}

/**
 * How many times a consume whose outcome is UNKNOWN is sent before giving up.
 * Safe to repeat only because every attempt carries the same idempotency key:
 * billing answers a repeated key with its original outcome and spends nothing.
 */
const CONSUME_ATTEMPTS = 3;

/** What one consume attempt established. `unknown` = billing may have committed. */
type ConsumeOutcome = 'consumed' | 'none' | 'unknown';

async function consumeOnce(orgId: string, key: string): Promise<ConsumeOutcome> {
  let res: InternalCallResult<ContractResponse<typeof CONSUME>>;
  try {
    res = await postToBilling(CONSUME, orgId, key);
  } catch (err) {
    // A timeout is the case that matters: the request may have reached billing
    // and committed after we stopped waiting. An open circuit breaker (nothing
    // sent) is also counted unknown — a PRIOR attempt in this loop may still
    // have committed, so it must not end the loop as a definite "none".
    logger.warn('Incident consume unavailable', { orgId, error: errorMessage(err) });
    return 'unknown';
  }
  if (res.ok) return res.data.consumed ? 'consumed' : 'none';
  if (res.reason === 'status') {
    logger.warn('Incident consume refused by billing', { orgId, status: res.status });
    // A 4xx is refused before the balance is touched (auth, validation, rate
    // limit); a 5xx may have failed after the spend committed.
    return res.status < 500 ? 'none' : 'unknown';
  }
  // A 2xx whose reply does not match the contract carries no trustworthy
  // `consumed` flag, so the outcome is UNKNOWN.
  logger.warn('Incident consume reply unreadable', { orgId });
  return 'unknown';
}

/**
 * Spend one incident for `orgId` under `key`, the idempotency key the caller
 * generated for this support submission. `false` when there were none, or when
 * billing's answer could not be learned.
 *
 * FAILS CLOSED, and this is the one support read that must. Everywhere else the
 * rule is "fail closed on the promise, open on reachability" — a support MESSAGE
 * always lands. But spending an incident is not a promise, it is a purchase
 * decision: assuming one was available when billing is unreachable would open a
 * case the customer never paid for and had no entitlement to. The message still
 * lands either way; only the CASE is withheld.
 *
 * AN UNKNOWN OUTCOME IS NOT "NOT CONSUMED". A timeout or an unreadable reply
 * can follow a spend billing committed, and treating it as "none" spent the
 * incident on no case with no refund. So an unknown outcome is re-sent with the
 * SAME key (bounded by {@link CONSUME_ATTEMPTS}) — billing replays the original
 * outcome — and if it is still unknown, refunded under that key, which billing
 * no-ops when the key never spent anything.
 *
 * Never throws: the caller is mid-send.
 */
export async function consumeSupportIncident(orgId: string, key: string): Promise<boolean> {
  for (let attempt = 1; attempt <= CONSUME_ATTEMPTS; attempt += 1) {
    const outcome = await consumeOnce(orgId, key);
    if (outcome === 'consumed') return true;
    if (outcome === 'none') return false;
  }
  logger.warn('Incident consume outcome unknown after retries — refunding under the same key', {
    orgId, attempts: CONSUME_ATTEMPTS,
  });
  await refundSupportIncident(orgId, key);
  return false;
}

/**
 * Give back the incident spent under `key` when the case it was spent on did
 * not open — the case insert failed, the send itself failed before the case
 * step was reached, or the consume's outcome could not be learned. Billing
 * refunds only a spend that happened under that key, once.
 *
 * Without this a customer loses a concession to our own bug, which is the worst
 * possible way to spend one. Best-effort and never thrown: failing the request
 * to report a failed refund would turn one problem into two (and on a failed
 * send, would replace the real error). A refund that does not land is visible
 * in the balance and recoverable by granting another.
 */
export async function refundSupportIncident(orgId: string, key: string): Promise<void> {
  try {
    const res = await postToBilling(REFUND, orgId, key);
    if (!res.ok && res.reason === 'status') {
      logger.error('Incident refund refused by billing', { orgId, status: res.status });
    }
  } catch (err) {
    logger.error('Incident refund unavailable — a concession was spent on a failed case', {
      orgId,
      error: errorMessage(err),
    });
  }
}
