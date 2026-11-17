// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal endpoints SERVED BY billing.
 *
 *  - support incidents: the message service spends an org's one-time support
 *    incident when a case is opened against no contact seat, and refunds it
 *    when that case did not open (or the consume's outcome was unknown).
 */

import { z } from 'zod';
import { defineInternalEndpoint } from './define.js';

/** A support-incident idempotency key: the caller's per-submission id. */
export const INCIDENT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const INCIDENT_KEY_MESSAGE = 'idempotencyKey must be 8-128 characters of [A-Za-z0-9_-]';

/** `{ idempotencyKey }` — the body of the internal consume and refund. */
const IncidentKeyBody = z.object({
  idempotencyKey: z.string({ error: INCIDENT_KEY_MESSAGE }).regex(INCIDENT_KEY_PATTERN, INCIDENT_KEY_MESSAGE),
}).strict();

const OrgIdParams = z.object({ orgId: z.string().min(1) });

const INCIDENT_AUTH = 'Service token (any org binding; the message service sends a system-org member token). '
  + 'The org is the PATH param, resolved to its account root by billing.';

export const BILLING_INTERNAL = {
  /**
   * Spend exactly one incident, atomically. A repeated `idempotencyKey` answers
   * with that key's ORIGINAL outcome and spends nothing. `consumed: false` is a
   * normal 200 (the org had none), never a 4xx. 503 when the account root
   * cannot be resolved.
   */
  consumeSupportIncident: defineInternalEndpoint({
    id: 'billing.consumeSupportIncident',
    service: 'billing',
    method: 'POST',
    path: '/billing/internal/support-incidents/:orgId/consume',
    callers: ['message'],
    auth: INCIDENT_AUTH,
    params: OrgIdParams,
    body: IncidentKeyBody,
    response: z.object({ consumed: z.boolean(), remaining: z.number() }),
  }),
  /**
   * Give back the incident spent under `idempotencyKey` — only a spend that
   * happened, once. `refunded: false` is the no-op for a key never spent (or
   * already refunded); `balance` is null when the org has no manageable
   * subscription.
   */
  refundSupportIncident: defineInternalEndpoint({
    id: 'billing.refundSupportIncident',
    service: 'billing',
    method: 'POST',
    path: '/billing/internal/support-incidents/:orgId/refund',
    callers: ['message'],
    auth: INCIDENT_AUTH,
    params: OrgIdParams,
    body: IncidentKeyBody,
    response: z.object({ refunded: z.boolean(), balance: z.number().nullable() }),
  }),
} as const;
