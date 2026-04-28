// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { CoreConstants } from '@pipeline-builder/pipeline-core';
import { Response } from 'express';
import { v7 as uuid } from 'uuid';

const logger = createLogger('SSEManager');

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
}

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
  private readonly maxClientsPerRequest: number;
  private readonly maxTotalClients: number;
  private readonly clientTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: SSEManagerOptions = {}) {
    this.maxClientsPerRequest = options.maxClientsPerRequest ?? parseInt(process.env.SSE_MAX_CLIENTS_PER_REQUEST || '10', 10);
    this.maxTotalClients = options.maxTotalClients ?? parseInt(process.env.SSE_MAX_TOTAL_CLIENTS || '1000', 10);
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

  /**
   * Adds a client to the SSE manager
   *
   * @param requestId - Unique request ID
   * @param res - Express Response object
   * @returns true if client was added, false if rejected (limit reached)
   */
  addClient(requestId: string, res: Response): boolean {
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

  /**
   * Removes a client from the manager
   */
  private removeClient(requestId: string, clientId: string): void {
    const clients = this.clients.get(requestId);
    if (!clients) return;

    const remaining = clients.filter(c => {
      if (c.id === clientId) {
        clearTimeout(c.timeout);
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
   * Middleware to initialize SSE connection
   *
   * @example
   * ```typescript
   * app.get('/logs/:requestId', sseManager.middleware());
   * ```
   */
  middleware() {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    return (req: { params: { requestId: string } }, res: Response) => {
      const { requestId } = req.params;

      if (!UUID_RE.test(requestId)) {
        res.status(400).end('Invalid requestId format');
        return;
      }

      // Check client limit BEFORE flushing headers, so we can still send 429
      const existing = this.clients.get(requestId) || [];
      if (existing.length >= this.maxClientsPerRequest) {
        logger.warn(`Client limit reached for request ${requestId} (max: ${this.maxClientsPerRequest})`);
        res.status(429).end('Too many connections for this request');
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      this.addClient(requestId, res);
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
