// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { createLogger, SSE_TICKET_TTL_MS } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import type { Response } from 'express';
import { v7 as uuid } from 'uuid';
import { createMemoryTicketStore, type SSETicketStore } from './sse-ticket-store.js';

const logger = createLogger('sse-manager');

/**
 * Event types for SSE logging
 */
export type SSEEventType = 'INFO' | 'WARN' | 'ERROR' | 'COMPLETED' | 'ROLLBACK' | 'MESSAGE';

/**
 * SSE payload structure
 */
export interface SSEPayload {
  ts: string;
  type: SSEEventType;
  message: string;
  data?: unknown;
}

/**
 * SSE client with connection tracking
 */
export interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
  timeout: NodeJS.Timeout;
  /** Number of consecutive backpressure events (write returned false). */
  backpressureCount: number;
  /** Owning org id — populated when the request was authenticated. Used to
   *  decrement the per-org counter on disconnect / cleanup. */
  orgId?: string;
}

/**
 * SSE Manager configuration options
 */
export interface SSEManagerOptions {
  /** Maximum clients allowed per request ID (default: 10) */
  maxClientsPerRequest?: number;
  /** Client timeout in milliseconds (default: 30 minutes) */
  clientTimeoutMs?: number;
  /** Interval for cleanup checks in milliseconds (default: 5 minutes) */
  cleanupIntervalMs?: number;
  /**
   * Hard cap on total open connections per process. Defaults to 1000 from
   * `SSE_MAX_TOTAL_CLIENTS`. New connections beyond this are rejected at
   * `addClient()`. Tune up if your service serves > 1000 concurrent SSE
   * dashboards, but be aware Node.js fd limits dominate above ~5000.
   */
  maxTotalClients?: number;
  /**
   * Per-org ceiling on concurrent SSE streams. Defaults to 50 from
   * `SSE_MAX_CLIENTS_PER_ORG`. Protects against one noisy org consuming the
   * process-wide budget — without it, an authenticated user can fan out
   * thousands of streams (one per dashboard / log stream) and starve other
   * orgs of connection slots. The cap is enforced only on `addClient` calls
   * that carry an `orgId`; service-internal / anonymous SSE traffic skips it.
   */
  maxClientsPerOrg?: number;
  /**
   * Hard cap on total live (unconsumed, unexpired) SSE tickets across the
   * process. Defaults to 1000 from `SSE_MAX_TOTAL_TICKETS`. Bounds memory
   * under abuse — `createTicket` returns `{ ok: false, reason: 'capacity' }`
   * once reached.
   */
  maxTotalTickets?: number;
  /**
   * Per-org cap on live SSE tickets. Defaults to 10 from
   * `SSE_MAX_TICKETS_PER_ORG`. Prevents a single tenant from saturating the
   * ticket table — `createTicket` returns `{ ok: false, reason: 'org-limit' }`
   * once reached.
   */
  maxTicketsPerOrg?: number;
  /** Ticket TTL in ms (default: `SSE_TICKET_TTL_MS` from api-core). */
  ticketTtlMs?: number;
  /**
   * Ticket + stream-ownership backend. Defaults to an in-memory store (correct
   * single-replica only). Inject `createEnvRedisTicketStore()` (or a bespoke
   * `SSETicketStore`) so ticket mint/redeem AND stream ownership work across
   * horizontally-scaled pods and — critically — so the platform stream producer
   * (a different service) can bind ownership that this service reads.
   */
  ticketStore?: SSETicketStore;
  /**
   * TTL for a stream-ownership binding (default: `SSE_STREAM_OWNER_TTL_MS` env or
   * 1h). Long enough to outlive a build; the producer re-binds as needed.
   */
  streamOwnerTtlMs?: number;
}

/**
 * A build-log stream subject id: either a dashed UUID (api-server's `uuid()`)
 * or nginx's `$request_id` — 16 random bytes rendered as 32 hex chars with NO
 * dashes. Accept both by making the group separators optional; still strictly
 * 32 hex chars so it can't carry an injection / path-traversal payload into the
 * SSE subject. Shared by the ticket-mint route and the stream middleware so
 * both validate the subject identically.
 */
export const SSE_REQUEST_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Result of {@link SSEManager.createTicket}. */
export type CreateTicketResult =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'org-limit' | 'capacity' | 'forbidden' };

/**
 * SSE Manager statistics
 */
export interface SSEManagerStats {
  totalRequests: number;
  totalClients: number;
  oldestConnectionMs: number | null;
}

/**
 * SSE helper class with memory leak protection
 *
 * Features:
 * - Client limits per request ID
 * - Automatic timeout for idle connections
 * - Periodic cleanup of stale connections
 * - Connection statistics
 *
 * @example
 * ```typescript
 * const sseManager = new SSEManager({ maxClientsPerRequest: 5 });
 * app.get('/logs/:requestId', sseManager.middleware());
 *
 * // Send events
 * sseManager.send('request-123', 'INFO', 'Processing...');
 * ```
 */
export class SSEManager {
  private clients = new Map<string, SSEClient[]>();
  /** Per-org open-client counters. Decremented on removeClient/cleanup so the
   *  map mirrors `clients[].orgId` counts at all times. Orgs reach zero are
   *  deleted to keep the map bounded. */
  private orgClientCounts = new Map<string, number>();
  /** Ticket + stream-ownership backend (in-memory default; Redis for multi-pod).
   *  Bounded by `maxTotalTickets` / `maxTicketsPerOrg`, enforced in createTicket;
   *  expiry is validated at consume time and swept on the cleanup interval. */
  private readonly ticketStore: SSETicketStore;
  private readonly maxClientsPerRequest: number;
  private readonly maxTotalClients: number;
  private readonly maxClientsPerOrg: number;
  private readonly maxTotalTickets: number;
  private readonly maxTicketsPerOrg: number;
  private readonly ticketTtlMs: number;
  private readonly streamOwnerTtlMs: number;
  private readonly clientTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: SSEManagerOptions = {}) {
    this.maxClientsPerRequest = options.maxClientsPerRequest ?? parseInt(process.env.SSE_MAX_CLIENTS_PER_REQUEST || '10', 10);
    this.maxTotalClients = options.maxTotalClients ?? parseInt(process.env.SSE_MAX_TOTAL_CLIENTS || '1000', 10);
    this.maxClientsPerOrg = options.maxClientsPerOrg ?? parseInt(process.env.SSE_MAX_CLIENTS_PER_ORG || '50', 10);
    this.maxTotalTickets = options.maxTotalTickets ?? parseInt(process.env.SSE_MAX_TOTAL_TICKETS || '1000', 10);
    this.maxTicketsPerOrg = options.maxTicketsPerOrg ?? parseInt(process.env.SSE_MAX_TICKETS_PER_ORG || '10', 10);
    this.ticketTtlMs = options.ticketTtlMs ?? SSE_TICKET_TTL_MS;
    this.streamOwnerTtlMs = options.streamOwnerTtlMs ?? parseInt(process.env.SSE_STREAM_OWNER_TTL_MS || '3600000', 10); // 1 hour
    this.ticketStore = options.ticketStore ?? createMemoryTicketStore();
    this.clientTimeoutMs = options.clientTimeoutMs ?? parseInt(process.env.SSE_CLIENT_TIMEOUT_MS || '1800000', 10); // 30 minutes

    const cleanupIntervalMs = options.cleanupIntervalMs ?? parseInt(process.env.SSE_CLEANUP_INTERVAL_MS || '300000', 10); // 5 minutes
    this.startCleanupInterval(cleanupIntervalMs);
  }

  /** Total open connections across all requests. */
  private totalClients(): number {
    let n = 0;
    for (const clients of this.clients.values()) n += clients.length;
    return n;
  }

  /** Current open-stream count for an org (0 if unseen). */
  getOrgClientCount(orgId: string): number {
    return this.orgClientCounts.get(orgId) ?? 0;
  }

  /**
   * Canonical form of a requestId for equality checks: dashes stripped and
   * lowercased, so the dashed (api-server `uuid()`) and undashed (nginx
   * `$request_id`) renderings of the same id compare equal. Callers are
   * expected to have already format-validated against {@link SSE_REQUEST_ID_RE}.
   */
  private static normalizeRequestId(requestId: string): string {
    return requestId.replace(/-/g, '').toLowerCase();
  }

  /**
   * Canonical form of an orgId for ownership equality checks: trimmed and
   * lowercased. The stream PRODUCER (bindStreamOwner) and the ticket-minting
   * CONSUMER (createTicket) run in different services, so a casing / whitespace
   * drift between how each renders the same org would otherwise make the owner
   * comparison in {@link createTicket} false-`forbidden` the real owner.
   * Normalizing both sides — mirroring {@link normalizeRequestId} — closes that.
   */
  private static normalizeOrgId(orgId: string): string {
    return orgId.trim().toLowerCase();
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
    await this.ticketStore.bindStreamOwner(
      SSEManager.normalizeRequestId(requestId),
      SSEManager.normalizeOrgId(orgId),
      this.streamOwnerTtlMs,
    );
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
   * Bounded by `maxTotalTickets` (process-wide) and `maxTicketsPerOrg`
   * (per-tenant). Mirrors the message-service notifications ticket store.
   *
   * @param orgId - Owning org (normalized internally via normalizeOrgId).
   * @param requestId - The build-log stream subject this ticket authorizes.
   *   The caller must have format-validated it (see {@link SSE_REQUEST_ID_RE}).
   * @returns `{ ok: true, ticket }` on success, or `{ ok: false, reason }`
   *   where reason is `'org-limit'`, `'capacity'`, or `'forbidden'`.
   */
  async createTicket(orgId: string, requestId: string): Promise<CreateTicketResult> {
    // Ownership gate first — a cross-tenant mint attempt should never even
    // consume cap budget. Only enforced when an owner is actually bound. Both
    // sides are org-normalized so a producer/consumer casing drift can't
    // false-`forbidden` the real owner (mirrors requestId normalization).
    const normalized = SSEManager.normalizeRequestId(requestId);
    const normalizedOrg = SSEManager.normalizeOrgId(orgId);
    const owner = await this.ticketStore.getStreamOwner(normalized);
    if (owner && owner !== normalizedOrg) {
      logger.warn(`SSE ticket refused: org ${normalizedOrg} does not own stream subject`);
      return { ok: false, reason: 'forbidden' };
    }

    // Total cap next — protects process memory even when a single org is
    // the offender. Then the per-org cap for fair-share.
    if ((await this.ticketStore.total()) >= this.maxTotalTickets) {
      logger.warn(`SSE ticket cap reached (max: ${this.maxTotalTickets}); rejecting ticket request`);
      return { ok: false, reason: 'capacity' };
    }
    if ((await this.ticketStore.countForOrg(normalizedOrg)) >= this.maxTicketsPerOrg) {
      logger.warn(`Per-org SSE ticket cap reached for ${normalizedOrg} (max: ${this.maxTicketsPerOrg})`);
      return { ok: false, reason: 'org-limit' };
    }

    const ticket = randomBytes(24).toString('base64url');
    await this.ticketStore.put(ticket, { orgId: normalizedOrg, requestId: normalized }, this.ticketTtlMs);
    return { ok: true, ticket };
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
    const ticket = await this.ticketStore.consume(ticketId); // single-use
    if (!ticket) return null;
    // Subject binding — reject a ticket presented for a subject it was not
    // minted for. Both sides are normalized so dashed/undashed forms match.
    if (ticket.requestId !== SSEManager.normalizeRequestId(requestId)) return null;
    return { orgId: ticket.orgId };
  }

  /**
   * Adds a client to the SSE manager
   *
   * @param requestId - Unique request ID
   * @param res - Express Response object
   * @param orgId - Authenticated org id (optional). When set, enforces the
   *   per-org cap and the counter is decremented on disconnect/cleanup.
   * @returns true if client was added, false if rejected (limit reached)
   */
  addClient(requestId: string, res: Response, orgId?: string): boolean {
    const existing = this.clients.get(requestId) || [];

    // Check client limit
    if (existing.length >= this.maxClientsPerRequest) {
      logger.warn(`Client limit reached for request ${requestId} (max: ${this.maxClientsPerRequest})`);
      return false;
    }

    // Process-wide cap: protects fd table + memory from runaway dashboards.
    if (this.totalClients() >= this.maxTotalClients) {
      logger.warn(`Total SSE client cap reached (max: ${this.maxTotalClients}); rejecting new connection`);
      return false;
    }

    // Per-org cap: prevents one noisy org from monopolizing process-wide
    // slots. Enforced only when orgId is known — service-internal / anonymous
    // streams that never identify with an orgId stay subject to the global
    // ceilings above. Reserve atomically before insert so two concurrent
    // requests at the limit can't both succeed.
    if (orgId) {
      const orgCurrent = this.orgClientCounts.get(orgId) ?? 0;
      if (orgCurrent >= this.maxClientsPerOrg) {
        logger.warn(`Per-org SSE client cap reached for ${orgId} (max: ${this.maxClientsPerOrg}); rejecting new connection`);
        return false;
      }
      this.orgClientCounts.set(orgId, orgCurrent + 1);
    }

    // Create timeout for this client
    const clientId = uuid();
    const timeout = setTimeout(() => {
      logger.debug(`Client ${clientId} timed out for request ${requestId}`);
      this.removeClient(requestId, clientId);
      try {
        res.end();
      } catch (err) {
        logger.debug('Response already closed on timeout', { requestId, clientId, error: err instanceof Error ? err.message : String(err) });
      }
    }, this.clientTimeoutMs);

    const client: SSEClient = {
      id: clientId,
      res,
      connectedAt: Date.now(),
      timeout,
      backpressureCount: 0,
      orgId,
    };

    // Handle disconnection
    res.on('close', () => {
      clearTimeout(timeout);
      this.removeClient(requestId, clientId);
    });

    res.on('error', (err) => {
      logger.error(`SSE client error for request ${requestId}:`, err);
      clearTimeout(timeout);
      this.removeClient(requestId, clientId);
    });

    existing.push(client);
    this.clients.set(requestId, existing);

    logger.debug(`Client ${clientId} connected for request ${requestId} (total: ${existing.length})`);
    return true;
  }

  /** Drop one from the per-org counter. Idempotent: a counter at 0 stays at 0
   *  and the org key is removed from the map. */
  private decrementOrgCount(orgId?: string): void {
    if (!orgId) return;
    const current = this.orgClientCounts.get(orgId) ?? 0;
    if (current <= 1) this.orgClientCounts.delete(orgId);
    else this.orgClientCounts.set(orgId, current - 1);
  }

  /**
   * Removes a client from the manager
   */
  private removeClient(requestId: string, clientId: string): void {
    const clients = this.clients.get(requestId);
    if (!clients) return;

    const remaining = clients.filter(c => {
      if (c.id === clientId) {
        clearTimeout(c.timeout);
        // Mirror the per-org counter — must decrement here, not just in the
        // explicit close paths, since 'close'/'error' event handlers are the
        // primary disconnect signal in practice.
        this.decrementOrgCount(c.orgId);
        return false;
      }
      return true;
    });

    if (remaining.length === 0) {
      this.clients.delete(requestId);
      logger.debug(`All clients disconnected for request ${requestId}`);
    } else {
      this.clients.set(requestId, remaining);
    }
  }

  /**
   * Sends a message to all SSE clients for a requestId
   *
   * @param requestId - Request ID
   * @param type - Event type
   * @param message - Message string
   * @param data - Optional additional data
   * @returns Number of clients the message was sent to
   */
  send(requestId: string, type: SSEEventType, message: string, data?: unknown): number {
    const payload: SSEPayload = {
      ts: new Date().toISOString(),
      type,
      message,
      data,
    };

    const clients = [...(this.clients.get(requestId) || [])];
    let sentCount = 0;
    const serialized = `data: ${JSON.stringify(payload)}\n\n`;

    for (const client of clients) {
      try {
        // Backpressure: skip clients whose write buffer is full
        if (client.res.writableEnded) {
          this.removeClient(requestId, client.id);
          continue;
        }
        const canWrite = client.res.write(serialized);
        if (!canWrite) {
          client.backpressureCount++;
          // Disconnect clients that consistently can't keep up (10 consecutive backpressure events)
          if (client.backpressureCount >= CoreConstants.SSE_BACKPRESSURE_THRESHOLD) {
            logger.warn(`Disconnecting slow client ${client.id} for request ${requestId} (${client.backpressureCount} backpressure events)`);
            this.removeClient(requestId, client.id);
            try { client.res.end(); } catch { /* already closed */ }
            continue;
          }
        } else {
          client.backpressureCount = 0; // Reset on successful write
        }
        sentCount++;
      } catch (error) {
        logger.error(`Failed to send to client ${client.id}:`, error);
        this.removeClient(requestId, client.id);
      }
    }

    return sentCount;
  }

  /**
   * Broadcast a message to all connected clients across all requests
   *
   * @param type - Event type
   * @param message - Message string
   * @param data - Optional additional data
   * @returns Total number of clients the message was sent to
   */
  broadcast(type: SSEEventType, message: string, data?: unknown): number {
    let totalSent = 0;
    for (const requestId of this.clients.keys()) {
      totalSent += this.send(requestId, type, message, data);
    }
    return totalSent;
  }

  /**
   * Close all clients for a specific request
   *
   * @param requestId - Request ID to close
   * @param finalMessage - Optional final message to send before closing
   */
  closeRequest(requestId: string, finalMessage?: string): void {
    const clients = this.clients.get(requestId);
    if (!clients) return;

    if (finalMessage) {
      this.send(requestId, 'COMPLETED', finalMessage);
    }

    for (const client of clients) {
      clearTimeout(client.timeout);
      this.decrementOrgCount(client.orgId);
      try {
        client.res.end();
      } catch (err) {
        logger.debug('Response already closed on request close', { requestId, clientId: client.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.clients.delete(requestId);
    logger.debug(`Closed all clients for request ${requestId}`);
  }

  /**
   * Get statistics about current connections
   */
  getStats(): SSEManagerStats {
    let totalClients = 0;
    let oldestConnection: number | null = null;
    const now = Date.now();

    for (const clients of this.clients.values()) {
      totalClients += clients.length;
      for (const client of clients) {
        const age = now - client.connectedAt;
        if (oldestConnection === null || age > oldestConnection) {
          oldestConnection = age;
        }
      }
    }

    return {
      totalRequests: this.clients.size,
      totalClients,
      oldestConnectionMs: oldestConnection,
    };
  }

  /**
   * Check if a request has any connected clients
   */
  hasClients(requestId: string): boolean {
    const clients = this.clients.get(requestId);
    return clients !== undefined && clients.length > 0;
  }

  /**
   * Get the number of clients for a specific request
   */
  getClientCount(requestId: string): number {
    return this.clients.get(requestId)?.length ?? 0;
  }

  /**
   * Middleware to initialize a ticket-authenticated SSE connection.
   *
   * The stream is NOT open to the world: the caller must first exchange its
   * JWT for a short-lived single-use ticket (see {@link createTicket}, wired to
   * `POST /logs/ticket`) and pass it as `?ticket=<t>`. The middleware validates
   * + consumes the ticket, binds the connection to the ticket's org, and
   * enforces the per-org connection cap. A missing / invalid / expired /
   * already-used ticket is rejected with 401 before any SSE headers flush.
   *
   * @example
   * ```typescript
   * app.get('/logs/:requestId', sseManager.middleware());
   * ```
   */
  middleware() {
    return async (req: { params: { requestId: string }; query?: { ticket?: unknown } }, res: Response) => {
      const { requestId } = req.params;

      if (!SSE_REQUEST_ID_RE.test(requestId)) {
        res.status(400).end('Invalid requestId format');
        return;
      }

      // Ticket auth — required. Resolve `?ticket=<t>`, then validate + consume
      // it (single-use) FOR THIS SUBJECT. An anonymous, malformed, unknown,
      // expired, already-consumed, or wrong-subject ticket is a 401. The org is
      // taken from the ticket, so the stream is always bound to a verified
      // tenant AND to the exact subject the ticket was minted for (no anonymous
      // streams, no cross-subject attach).
      const ticketId = req.query?.ticket;
      if (typeof ticketId !== 'string' || ticketId.length === 0) {
        res.status(401).end('Missing ticket');
        return;
      }
      const consumed = await this.consumeTicket(ticketId, requestId);
      if (!consumed) {
        res.status(401).end('Invalid or expired ticket');
        return;
      }
      const orgId = consumed.orgId;

      // Pre-flight per-request cap so we can return 429 before flushing
      // SSE headers (after headers are flushed the client can't read a 429).
      const existing = this.clients.get(requestId) || [];
      if (existing.length >= this.maxClientsPerRequest) {
        logger.warn(`Client limit reached for request ${requestId} (max: ${this.maxClientsPerRequest})`);
        res.status(429).end('Too many connections for this request');
        return;
      }

      // Same for the per-org cap — better to send 429 than open the stream and
      // immediately close it. The ticket guarantees a verified org id, so the
      // per-org ceiling is always enforced for the /logs stream.
      if ((this.orgClientCounts.get(orgId) ?? 0) >= this.maxClientsPerOrg) {
        logger.warn(`Per-org SSE client cap reached for ${orgId} (max: ${this.maxClientsPerOrg})`);
        res.status(429).end('Too many SSE connections for this organization');
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      // Headers are flushed — we can no longer send a 429. addClient re-checks
      // the caps (including the process-wide total-clients cap, which the
      // pre-flight above does not) and can still reject on a race: a concurrent
      // connection may have filled a cap between the pre-flight check and here.
      // On rejection, close the now-dangling response instead of leaving an
      // open socket with no client record (which would leak an fd + never emit
      // stream data).
      const added = this.addClient(requestId, res, orgId);
      if (!added) {
        logger.warn(`SSE addClient rejected after headers flushed for request ${requestId}; closing dangling response`);
        try { res.end(); } catch { /* already closed */ }
      }
    };
  }

  /**
   * Start periodic cleanup of stale connections
   */
  private startCleanupInterval(intervalMs: number): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, intervalMs);

    // Don't prevent process exit
    this.cleanupInterval.unref();
  }

  /**
   * Clean up stale connections using single-pass partition.
   * O(R × C) instead of O(R × C²), and avoids mutation-during-iteration.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // Sweep expired tickets/owners so an in-memory store stays bounded even when
    // tickets are minted but never consumed (client closed the tab before
    // connecting). Consume-time still re-checks expiry, so this is memory
    // hygiene only; the Redis store relies on native key TTL (sweep is a no-op).
    void this.ticketStore.sweep?.();

    for (const [requestId, clients] of this.clients.entries()) {
      const stale: SSEClient[] = [];
      const active: SSEClient[] = [];

      for (const client of clients) {
        // Time-based eviction OR a socket that silently closed (no 'close'
        // event) — Node sometimes drops sockets without firing the event,
        // so we explicitly check writableEnded/destroyed here.
        const ageStale = now - client.connectedAt > this.clientTimeoutMs;
        const socketDead = client.res.writableEnded || (client.res as { destroyed?: boolean }).destroyed === true;
        if (ageStale || socketDead) {
          stale.push(client);
        } else {
          active.push(client);
        }
      }

      for (const client of stale) {
        clearTimeout(client.timeout);
        this.decrementOrgCount(client.orgId);
        try { client.res.end(); } catch { /* already closed */ }
        cleaned++;
      }

      if (active.length === 0) {
        this.clients.delete(requestId);
      } else if (stale.length > 0) {
        this.clients.set(requestId, active);
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} stale SSE connections`);
    }
  }

  /**
   * Shutdown the SSE manager and close all connections
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const requestId of [...this.clients.keys()]) {
      this.closeRequest(requestId, 'Server shutting down');
    }

    logger.info('SSE Manager shut down');
  }
}
