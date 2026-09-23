// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { createLogger, writeSseHeaders, type SseTicketStore, errorMessage, envInt } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import type { Response } from 'express';
import { v7 as uuid } from 'uuid';
import type { SSERelay, SSERelayMessage } from './sse-relay.js';
import { normalizeRequestId, SseTicketBroker, type CreateTicketResult } from './sse-ticket-broker.js';
import { incCounter, setGauge } from '../api/metrics.js';

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
   * Cap on live log-stream tickets across the process, for the DEFAULT
   * in-memory ticket store. Defaults to 1000 from `SSE_MAX_TOTAL_TICKETS`.
   * Ignored when `ticketStore` is injected (the store carries its own caps).
   */
  maxTotalTickets?: number;
  /**
   * Per-org cap on live log-stream tickets, for the DEFAULT in-memory ticket
   * store. Defaults to 10 from `SSE_MAX_TICKETS_PER_ORG`. Ignored when
   * `ticketStore` is injected.
   */
  maxTicketsPerOrg?: number;
  /** Ticket TTL in ms for the default store (default: `SSE_TICKET_TTL_MS` from api-core). */
  ticketTtlMs?: number;
  /**
   * Ticket + stream-ownership backend for the subject-bound log stream. Defaults
   * to an in-memory store (single replica only), built on first use. Inject an
   * api-core `createEnvSseTicketStore(...)` so mint/redeem and stream ownership
   * work across pods.
   */
  ticketStore?: SseTicketStore;
  /**
   * Whether this service streams per-request logs (`ctx.log` frames keyed by
   * requestId, the `/logs` channel). Default false: `ctx.log` then only writes
   * to the logger, so a service that never serves a log stream doesn't push
   * every log line through SSE (and over Redis).
   */
  logStream?: boolean;
  /**
   * TTL for a stream-ownership binding (default 1h). Long enough to outlive a
   * build; the producer re-binds as needed.
   */
  streamOwnerTtlMs?: number;
  /**
   * Cross-pod fan-out bus for `send()`/`broadcast()`, wired at construction.
   * When omitted (and no `relayFactory` is enabled) delivery is LOCAL-ONLY.
   * Degrades to local-only during a Redis outage.
   */
  relay?: SSERelay;
  /**
   * Builds the relay on demand — see {@link SSEManager.enableRelay}. Lets a
   * service open a relay connection only when it actually has a streaming
   * channel (the log stream, or an org-keyed channel). Returning null (Redis
   * not configured) keeps local-only delivery.
   */
  relayFactory?: () => SSERelay | null;
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

export type { CreateTicketResult };

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
  /** Ticket minting / redemption + stream ownership (see ./sse-ticket-broker.ts). */
  private readonly tickets: SseTicketBroker;
  private readonly maxClientsPerRequest: number;
  private readonly maxTotalClients: number;
  private readonly maxClientsPerOrg: number;
  private readonly clientTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  /** Cross-pod fan-out bus (undefined ⇒ local-only delivery). */
  private relay?: SSERelay;
  private readonly relayFactory?: () => SSERelay | null;
  /** Whether `ctx.log` frames are streamed (see {@link SSEManagerOptions.logStream}). */
  readonly logStreamEnabled: boolean;
  /** This manager instance's id — tags relayed frames so we ignore our own echo. */
  private readonly nodeId = randomBytes(8).toString('hex');

  constructor(options: SSEManagerOptions = {}) {
    this.maxClientsPerRequest = options.maxClientsPerRequest ?? envInt('SSE_MAX_CLIENTS_PER_REQUEST', 10, { min: 1 });
    this.maxTotalClients = options.maxTotalClients ?? envInt('SSE_MAX_TOTAL_CLIENTS', 1000, { min: 1 });
    this.maxClientsPerOrg = options.maxClientsPerOrg ?? envInt('SSE_MAX_CLIENTS_PER_ORG', 50, { min: 1 });
    this.tickets = new SseTicketBroker({
      store: options.ticketStore,
      maxTotal: options.maxTotalTickets,
      maxPerOrg: options.maxTicketsPerOrg,
      ttlMs: options.ticketTtlMs,
      ownerTtlMs: options.streamOwnerTtlMs,
    });
    this.logStreamEnabled = options.logStream ?? false;
    this.clientTimeoutMs = options.clientTimeoutMs ?? envInt('SSE_CLIENT_TIMEOUT_MS', 1_800_000, { min: 1 }); // 30 minutes

    const cleanupIntervalMs = options.cleanupIntervalMs ?? envInt('SSE_CLEANUP_INTERVAL_MS', 300_000, { min: 1 }); // 5 minutes
    this.startCleanupInterval(cleanupIntervalMs);

    // Wire the cross-pod relay: subscribe once on startup so frames PUBLISHED by
    // any other pod are re-emitted to THIS pod's local clients. Frames we
    // published ourselves are ignored (origin === nodeId) — we already wrote them
    // locally. Fail-safe: no relay ⇒ local-only delivery (single-replica default).
    this.relayFactory = options.relayFactory;
    if (options.relay) this.attachRelay(options.relay);
  }

  private attachRelay(relay: SSERelay): void {
    this.relay = relay;
    relay.subscribe((msg) => this.onRelayMessage(msg));
  }

  /**
   * Turn on cross-pod delivery using the configured `relayFactory`. Idempotent;
   * a no-op when a relay is already wired or no factory was given, and when the
   * factory returns null (Redis not configured → local-only delivery).
   */
  enableRelay(): void {
    if (this.relay || !this.relayFactory) return;
    const relay = this.relayFactory();
    if (relay) this.attachRelay(relay);
  }

  /**
   * Handle a frame received from another pod via the relay. We already delivered
   * our OWN frames to local clients before publishing, so ignore our echo. A
   * `send` re-emits to the subject's local clients; a `broadcast` to all of them.
   * Purely local — never re-publishes, so there is no fan-out loop.
   */
  private onRelayMessage(msg: SSERelayMessage): void {
    if (!msg || msg.origin === this.nodeId) return;
    if (msg.kind === 'broadcast') {
      this.broadcastLocal(msg.payload);
    } else if (msg.requestId) {
      this.sendLocal(msg.requestId, msg.payload);
    }
  }

  /** Total open connections across all requests. */
  private totalClients(): number {
    let n = 0;
    for (const clients of this.clients.values()) n += clients.length;
    return n;
  }

  /**
   * Publish the current live-connection count as a gauge so on-call can see SSE
   * saturation (approach to the per-process cap) on a dashboard, not only in
   * `getStats()`/logs. Called after every add/remove/
   * close/cleanup. Cheap (O(R)); metric helpers never throw.
   */
  private updateActiveGauge(): void {
    setGauge('sse_active_connections', {}, this.totalClients());
  }

  /** Current open-stream count for an org (0 if unseen). */
  getOrgClientCount(orgId: string): number {
    return this.orgClientCounts.get(orgId) ?? 0;
  }

  /**
   * Record the org that OWNS a stream subject, so ticket minting can refuse a
   * cross-tenant mint. Delegates to the ticket broker.
   */
  async bindStreamOwner(requestId: string, orgId: string): Promise<void> {
    await this.tickets.bindStreamOwner(requestId, orgId);
  }

  /**
   * Mint a short-lived, single-use ticket bound to `orgId` AND this stream
   * subject — how a browser opens an EventSource without putting its JWT in a
   * query string. Delegates to the ticket broker, which owns the ownership and
   * cap rules.
   */
  async createTicket(orgId: string, requestId: string): Promise<CreateTicketResult> {
    return this.tickets.createTicket(orgId, requestId);
  }

  /**
   * Validate and CONSUME a ticket for a specific stream subject (single-use,
   * subject-bound). Delegates to the ticket broker.
   */
  async consumeTicket(ticketId: string, requestId: string): Promise<{ orgId: string } | null> {
    return this.tickets.consumeTicket(ticketId, requestId);
  }


  /**
   * Adds a client to the SSE manager
   *
   * @param requestId - Unique request ID
   * @param res - Express Response object
   * @param orgId - Authenticated org id (optional). When set, enforces the
   *   per-org cap and the counter is decremented on disconnect/cleanup.
   * @param maxClientsForSubject - Per-subject cap override (default
   *   `maxClientsPerRequest`). An org-keyed channel's subject IS the org, so it
   *   must not inherit the small per-build-request cap — see {@link addOrgClient}.
   * @returns true if client was added, false if rejected (limit reached)
   */
  addClient(requestId: string, res: Response, orgId?: string, maxClientsForSubject: number = this.maxClientsPerRequest): boolean {
    // Normalize the map key: the subject id is allowed in two forms (dashed
    // api-server uuid vs undashed nginx $request_id), and a producer/consumer that
    // render it differently would otherwise key different Map entries — the client
    // registers under one and every send()/relay writes to another, dropping all
    // frames. Normalizing here (and in send/sendLocal/closeRequest/etc.) unifies them.
    requestId = normalizeRequestId(requestId);
    const existing = this.clients.get(requestId) || [];

    // Check client limit
    if (existing.length >= maxClientsForSubject) {
      logger.warn(`Client limit reached for request ${requestId} (max: ${maxClientsForSubject})`);
      incCounter('sse_connection_rejected_total', { reason: 'request-limit' });
      return false;
    }

    // Process-wide cap: protects fd table + memory from runaway dashboards.
    if (this.totalClients() >= this.maxTotalClients) {
      logger.warn(`Total SSE client cap reached (max: ${this.maxTotalClients}); rejecting new connection`);
      incCounter('sse_connection_rejected_total', { reason: 'total-cap' });
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
        incCounter('sse_connection_rejected_total', { reason: 'org-cap' });
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
        logger.debug('Response already closed on timeout', { requestId, clientId, error: errorMessage(err) });
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
    incCounter('sse_connections_total', {});
    this.updateActiveGauge();

    logger.debug(`Client ${clientId} connected for request ${requestId} (total: ${existing.length})`);
    return true;
  }

  /**
   * Attach a client to an ORG-keyed stream (the org is the subject). Counts
   * against the per-org cap, and the org — not the per-request cap — bounds how
   * many streams share the subject.
   */
  addOrgClient(orgId: string, res: Response): boolean {
    return this.addClient(orgId, res, orgId, this.maxClientsPerOrg);
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
    this.updateActiveGauge();
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
    requestId = normalizeRequestId(requestId); // unify producer/consumer key forms
    const payload: SSEPayload = {
      ts: new Date().toISOString(),
      type,
      message,
      data,
    };

    // Deliver to LOCAL clients first, then relay the SAME payload to other pods
    // so an EventSource attached on a different replica also receives it. The
    // relay is fire-and-forget and fail-safe: no relay / Redis down ⇒ local-only.
    const sentCount = this.sendLocal(requestId, payload);
    this.publishRelay({ origin: this.nodeId, kind: 'send', requestId, payload });
    return sentCount;
  }

  /**
   * Write a pre-built payload to this pod's LOCAL clients for `requestId`. Shared
   * by {@link send} (local half) and the relay re-emit path ({@link onRelayMessage}),
   * so a relayed frame reuses the producer's original `ts` rather than a new one.
   * Never relays — callers decide whether to publish.
   */
  private sendLocal(requestId: string, payload: SSEPayload): number {
    requestId = normalizeRequestId(requestId); // idempotent; covers the relay re-emit path
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
            incCounter('sse_backpressure_disconnects_total', {});
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
    const payload: SSEPayload = {
      ts: new Date().toISOString(),
      type,
      message,
      data,
    };
    // Deliver to local clients, then relay a single broadcast frame so EVERY pod
    // re-emits to ALL of its own clients — a per-requestId relay would miss
    // subjects that only exist on other replicas.
    const totalSent = this.broadcastLocal(payload);
    this.publishRelay({ origin: this.nodeId, kind: 'broadcast', payload });
    return totalSent;
  }

  /** Write a pre-built payload to all LOCAL clients across every request. */
  private broadcastLocal(payload: SSEPayload): number {
    let totalSent = 0;
    for (const requestId of [...this.clients.keys()]) {
      totalSent += this.sendLocal(requestId, payload);
    }
    return totalSent;
  }

  /** Fire-and-forget relay publish. No-op (local-only) when no relay is wired. */
  private publishRelay(msg: SSERelayMessage): void {
    this.relay?.publish(msg);
  }

  /**
   * Close all clients for a specific request
   *
   * @param requestId - Request ID to close
   * @param finalMessage - Optional final message to send before closing
   */
  closeRequest(requestId: string, finalMessage?: string): void {
    requestId = normalizeRequestId(requestId);
    if (!this.clients.has(requestId)) return;

    // LOCAL only: this closes this pod's clients, so the final frame is for them
    // (relaying it would push a COMPLETED to other pods' still-open streams).
    if (finalMessage) {
      this.sendLocal(requestId, { ts: new Date().toISOString(), type: 'COMPLETED', message: finalMessage });
    }

    // Read the entry AFTER the final write: sendLocal removes (and un-counts)
    // clients that were already gone, so iterating an earlier snapshot would
    // decrement their org count a second time.
    for (const client of this.clients.get(requestId) ?? []) {
      clearTimeout(client.timeout);
      this.decrementOrgCount(client.orgId);
      try {
        client.res.end();
      } catch (err) {
        logger.debug('Response already closed on request close', { requestId, clientId: client.id, error: errorMessage(err) });
      }
    }

    this.clients.delete(requestId);
    this.updateActiveGauge();
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
    const clients = this.clients.get(normalizeRequestId(requestId));
    return clients !== undefined && clients.length > 0;
  }

  /**
   * Get the number of clients for a specific request
   */
  getClientCount(requestId: string): number {
    return this.clients.get(normalizeRequestId(requestId))?.length ?? 0;
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
      //
      // NORMALIZE first: `addClient` keys the map on the normalized form
      // (dashes stripped), so reading the raw `requestId` here always found 0
      // for a client using the dashed form. The cap was then only caught inside
      // `addClient` — AFTER `flushHeaders()` — which is exactly the case this
      // pre-flight exists to avoid: the client got a silently-closed stream
      // instead of a 429.
      const existing = this.clients.get(normalizeRequestId(requestId)) || [];
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

      writeSseHeaders(res);
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
      incCounter('sse_stale_cleaned_total', {}, cleaned);
      this.updateActiveGauge();
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

    // Tear down the relay's Redis connections (best-effort; never throws).
    void this.relay?.close().catch(() => { /* already closing */ });
    this.tickets.shutdown();

    logger.info('SSE Manager shut down');
  }
}
