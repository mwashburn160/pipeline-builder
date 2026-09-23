// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minting and redeeming the short-lived SSE tickets that authorize a log
 * stream, plus the stream-ownership binding those mints are checked against.
 *
 * Separate from {@link SSEManager} because it shares nothing with the
 * connection registry: its state lives entirely in the injected
 * {@link SseTicketStore} (Redis in a multi-pod deploy), and every rule in here
 * is an AUTHORIZATION rule — who may open which subject's stream — which is
 * easier to audit as one unit than interleaved with connection bookkeeping.
 */

import { createLogger, createMemorySseTicketStore, envSseTicketCaps, SSE_TICKET_TTL_MS, type SseTicketStore, errorMessage } from '@pipeline-builder/api-core';
import { incCounter } from '../api/metrics.js';

const logger = createLogger('sse-tickets');

/** Result of {@link SseTicketBroker.createTicket}. */
export type CreateTicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'org-limit' | 'capacity' | 'forbidden' };

export interface SseTicketBrokerOptions {
  /** Ticket + stream-ownership backend. Defaults to an in-memory store (single
   *  replica only), built on first use. Inject an api-core
   *  `createEnvSseTicketStore(...)` so mint/redeem and stream ownership work
   *  across pods. */
  store?: SseTicketStore;
  /** Cap on live tickets across the process, for the DEFAULT in-memory store.
   *  Ignored when `store` is injected (the store carries its own caps). */
  maxTotal?: number;
  /** Per-org cap on live tickets, for the DEFAULT in-memory store. Ignored when
   *  `store` is injected. */
  maxPerOrg?: number;
  /** Ticket TTL in ms for the default store. */
  ttlMs?: number;
  /** TTL for a stream-ownership binding (default 1h). Long enough to outlive a
   *  build; the producer re-binds as needed. */
  ownerTtlMs?: number;
}

/**
 * Canonical form of a stream subject id for map/store keys: the id is allowed
 * in two renderings (a dashed api-server uuid and nginx's undashed
 * `$request_id`), and normalizing makes them compare equal. Callers are
 * expected to have already format-validated against `SSE_REQUEST_ID_RE`.
 */
export function normalizeRequestId(requestId: string): string {
  return requestId.replace(/-/g, '').toLowerCase();
}

/**
 * Canonical form of an orgId for ownership equality checks: trimmed and
 * lowercased. The stream PRODUCER (bindStreamOwner) and the ticket-minting
 * CONSUMER (createTicket) run in different services, so a casing / whitespace
 * drift between how each renders the same org would otherwise make the owner
 * comparison in {@link SseTicketBroker.createTicket} false-`forbidden` the real
 * owner. Normalizing both sides — mirroring {@link normalizeRequestId} — closes that.
 */
export function normalizeOrgId(orgId: string): string {
  return orgId.trim().toLowerCase();
}

export class SseTicketBroker {
  private storeInstance?: SseTicketStore;
  /** True when this broker built its store (so shutdown stops it). */
  private ownsStore = false;
  private readonly maxTotal: number;
  private readonly maxPerOrg: number;
  private readonly ttlMs: number;
  private readonly ownerTtlMs: number;

  constructor(options: SseTicketBrokerOptions = {}) {
    const caps = envSseTicketCaps();
    this.maxTotal = options.maxTotal ?? caps.maxTotal;
    this.maxPerOrg = options.maxPerOrg ?? caps.maxPerOrg;
    this.ttlMs = options.ttlMs ?? SSE_TICKET_TTL_MS;
    this.ownerTtlMs = options.ownerTtlMs ?? 3_600_000; // 1 hour
    this.storeInstance = options.store;
  }

  /** The ticket store, building the in-memory default on first use. */
  private get store(): SseTicketStore {
    if (!this.storeInstance) {
      this.storeInstance = createMemorySseTicketStore({
        ttlMs: this.ttlMs,
        maxTotal: this.maxTotal,
        maxPerOrg: this.maxPerOrg,
      });
      this.ownsStore = true;
    }
    return this.storeInstance;
  }

  /**
   * Record the org that OWNS a stream subject. The stream PRODUCER calls this
   * when it creates a build-log stream so that ticket minting can assert the
   * caller's org owns the subject (see {@link createTicket}). Backed by the
   * injected ticket store, so when a Redis store is wired the platform producer
   * (a different service sharing the same Redis) can bind ownership that this
   * service reads — closing the cross-tenant attach gap where any org could mint
   * a ticket for a guessed requestId.
   *
   * @param requestId - The stream subject (format-validated by the caller).
   * @param orgId - The owning org (normalized internally via normalizeOrgId).
   */
  async bindStreamOwner(requestId: string, orgId: string): Promise<void> {
    await this.store.bindOwner(normalizeRequestId(requestId), normalizeOrgId(orgId), this.ownerTtlMs);
  }

  /**
   * Mint a short-lived, single-use SSE ticket bound to `orgId` AND a specific
   * stream subject (`requestId`). Clients POST to obtain one (JWT-authenticated)
   * for the exact stream they intend to open, then open the EventSource with
   * `?ticket=<t>` so the JWT never lands in a query string / access log. The
   * ticket can then only be consumed to open that one subject's stream — see
   * {@link consumeTicket} — which is what enforces per-subject authorization.
   *
   * ORG-OWNERSHIP: if a stream owner has been bound for this subject (via
   * {@link bindStreamOwner}) and it is a DIFFERENT org, minting is refused
   * (`reason: 'forbidden'`) — an org cannot mint a ticket for another org's
   * stream even if it guesses the requestId. When no owner is bound (producer
   * wiring not yet present), minting falls back to binding the ticket to the
   * caller's own org, preserving current behavior.
   *
   * Bounded by the ticket store's live-ticket caps (total and per org). An
   * ownership lookup the store can't answer is refused as `capacity`.
   *
   * @param orgId - Owning org (normalized internally via normalizeOrgId).
   * @param requestId - The build-log stream subject this ticket authorizes.
   *   The caller must have format-validated it (see `SSE_REQUEST_ID_RE`).
   * @returns `{ ok: true, ticket }` on success, or `{ ok: false, reason }`
   *   where reason is `'org-limit'`, `'capacity'`, or `'forbidden'`.
   */
  async createTicket(orgId: string, requestId: string): Promise<CreateTicketResult> {
    // Ownership gate first — a cross-tenant mint attempt should never even
    // consume cap budget. Only enforced when an owner is actually bound. Both
    // sides are org-normalized so a producer/consumer casing drift can't
    // false-`forbidden` the real owner (mirrors requestId normalization).
    const normalized = normalizeRequestId(requestId);
    const normalizedOrg = normalizeOrgId(orgId);
    let owner: string | null;
    try {
      owner = await this.store.getOwner(normalized);
    } catch (err) {
      // Can't tell who owns the subject — refuse rather than mint unchecked.
      logger.warn('SSE ticket refused: stream ownership lookup failed', { error: errorMessage(err) });
      incCounter('sse_ticket_rejected_total', { reason: 'capacity' });
      return { ok: false, reason: 'capacity' };
    }
    if (owner && owner !== normalizedOrg) {
      logger.warn(`SSE ticket refused: org ${normalizedOrg} does not own stream subject`);
      incCounter('sse_ticket_rejected_total', { reason: 'forbidden' });
      return { ok: false, reason: 'forbidden' };
    }

    const issued = await this.store.issue(normalizedOrg, normalized);
    if (!issued.ok) {
      const reason = issued.reason === 'org' ? 'org-limit' : 'capacity';
      logger.warn(`SSE ticket refused (${reason}) for ${normalizedOrg}`);
      incCounter('sse_ticket_rejected_total', { reason });
      return { ok: false, reason };
    }
    return { ok: true, ticket: issued.ticket };
  }

  /**
   * Validate and CONSUME a ticket for a specific stream subject. Single-use:
   * the ticket is deleted whether or not it turns out to be valid, so a replay
   * of the same value always fails. Returns the bound org on success, or null
   * when the ticket is unknown / already-used / expired / OR was minted for a
   * DIFFERENT `requestId` than the one being opened.
   *
   * The subject check is the authorization fix: without it, a ticket minted for
   * one stream could be presented to open ANY stream the holder's org could
   * name, letting an authenticated org attach to another org's log stream by
   * guessing its requestId. The generic 401 the caller returns does not
   * distinguish "unknown ticket" from "wrong subject", so it leaks nothing
   * about which requestIds exist.
   *
   * @param ticketId - The opaque ticket value from `?ticket=`.
   * @param requestId - The stream subject from the URL path (`:requestId`),
   *   already format-validated by the caller.
   */
  async consumeTicket(ticketId: string, requestId: string): Promise<{ orgId: string } | null> {
    const ticket = await this.store.consume(ticketId); // single-use
    if (!ticket) return null;
    // Subject binding — reject a ticket presented for a subject it was not
    // minted for (including an unbound, org-channel ticket). Both sides are
    // normalized so dashed/undashed forms match.
    if (ticket.subject !== normalizeRequestId(requestId)) return null;
    return { orgId: ticket.orgId };
  }

  /** Stop the store, but only the one this broker built — an injected store is
   *  the caller's to close. */
  shutdown(): void {
    if (this.ownsStore) this.storeInstance?.stop();
  }
}
