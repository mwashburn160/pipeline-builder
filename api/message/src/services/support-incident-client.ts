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

import { SYSTEM_ORG_ID, createLogger, envInt, errorMessage, getServiceAuthHeader } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

const logger = createLogger('support-incident-client');

/** Bounded like the entitlement read: a slow billing must not hang a send. */
const TIMEOUT_MS = envInt('SUPPORT_INCIDENT_TIMEOUT_MS', 3000, { min: 250, max: 30_000 });

function billingUrl(path: string): string {
  const { billingHost, billingPort } = Config.get('server').services;
  return `http://${billingHost}:${billingPort}/billing${path}`;
}

/** Service principal, least privilege — a write, but on the CALLER's behalf. */
function authHeader(): string {
  return getServiceAuthHeader({ serviceName: 'message', orgId: SYSTEM_ORG_ID, role: 'member' });
}

/**
 * Spend one incident for `orgId`. `false` when there were none, or when billing
 * could not be reached.
 *
 * FAILS CLOSED, and this is the one support read that must. Everywhere else the
 * rule is "fail closed on the promise, open on reachability" — a support MESSAGE
 * always lands. But spending an incident is not a promise, it is a purchase
 * decision: assuming one was available when billing is unreachable would open a
 * case the customer never paid for and had no entitlement to. The message still
 * lands either way; only the CASE is withheld.
 *
 * Never throws: the caller is mid-send.
 */
export async function consumeSupportIncident(orgId: string): Promise<boolean> {
  try {
    const res = await fetch(billingUrl(`/internal/support-incidents/${encodeURIComponent(orgId)}/consume`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('Incident consume refused by billing', { orgId, status: res.status });
      return false;
    }
    const body = (await res.json()) as { data?: { consumed?: unknown } } | null;
    return body?.data?.consumed === true;
  } catch (err) {
    logger.warn('Incident consume unavailable', { orgId, error: errorMessage(err) });
    return false;
  }
}

/**
 * Give one back after a case insert failed.
 *
 * Without this a customer loses a concession to our own bug, which is the worst
 * possible way to spend one. Best-effort and never thrown: the send has already
 * succeeded by the time this runs, and failing it to report a failed refund
 * would turn one problem into two. A refund that does not land is visible in
 * the balance and recoverable by granting another.
 */
export async function refundSupportIncident(orgId: string): Promise<void> {
  try {
    const res = await fetch(billingUrl(`/internal/support-incidents/${encodeURIComponent(orgId)}/refund`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) logger.error('Incident refund refused by billing', { orgId, status: res.status });
  } catch (err) {
    logger.error('Incident refund unavailable — a concession was spent on a failed case', {
      orgId,
      error: errorMessage(err),
    });
  }
}
