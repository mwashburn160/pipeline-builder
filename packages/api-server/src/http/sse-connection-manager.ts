import { createLogger } from '@mwashburn160/api-core';
import { Response } from 'express';
import { v7 as uuid } from 'uuid';

const log = createLogger('SSEManager');

/**
 * Event types for SSE logging
 */
export type SSEEventType = 'INFO' | 'ERROR' | 'COMPLETED' | 'ROLLBACK';

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
  private readonly clientTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(options: SSEManagerOptions = {}) {
    this.maxClientsPerRequest = options.maxClientsPerRequest ?? 10;
    this.clientTimeoutMs = options.clientTimeoutMs ?? 30 * 60 * 1000; // 30 minutes

    const cleanupIntervalMs = options.cleanupIntervalMs ?? 5 * 60 * 1000; // 5 minutes
    this.startCleanupInterval(cleanupIntervalMs);
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
      log.warn(`Client limit reached for request ${requestId} (max: ${this.maxClientsPerRequest})`);
      return false;
    }

    // Create timeout for this client
    const clientId = uuid();
    const timeout = setTimeout(() => {
      log.debug(`Client ${clientId} timed out for request ${requestId}`);
      this.removeClient(requestId, clientId);
      try {
        res.end();
      } catch {
        // Response may already be closed
      }
    }, this.clientTimeoutMs);

    const client: SSEClient = {
      id: clientId,
      res,
      connectedAt: Date.now(),
      timeout,
    };

    // Handle disconnection
    res.on('close', () => {
      clearTimeout(timeout);
      this.removeClient(requestId, clientId);
    });

    res.on('error', (err) => {
      log.error(`SSE client error for request ${requestId}:`, err);
      clearTimeout(timeout);
      this.removeClient(requestId, clientId);
    });

    existing.push(client);
    this.clients.set(requestId, existing);

    log.debug(`Client ${clientId} connected for request ${requestId} (total: ${existing.length})`);
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
      log.debug(`All clients disconnected for request ${requestId}`);
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

    const clients = this.clients.get(requestId) || [];
    let sentCount = 0;

    for (const client of clients) {
      try {
        client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
        sentCount++;
      } catch (err) {
        log.error(`Failed to send to client ${client.id}:`, err);
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
      } catch {
        // Response may already be closed
      }
    }

    this.clients.delete(requestId);
    log.debug(`Closed all clients for request ${requestId}`);
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
    return (req: { params: { requestId: string } }, res: Response) => {
      const { requestId } = req.params;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      const added = this.addClient(requestId, res);

      if (!added) {
        res.status(429).end('Too many connections for this request');
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
   * Clean up stale connections
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [requestId, clients] of this.clients.entries()) {
      for (const client of clients) {
        const age = now - client.connectedAt;
        if (age > this.clientTimeoutMs) {
          this.removeClient(requestId, client.id);
          try {
            client.res.end();
          } catch {
            // Response may already be closed
          }
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      log.info(`Cleaned up ${cleaned} stale SSE connections`);
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

    for (const [requestId] of this.clients.entries()) {
      this.closeRequest(requestId, 'Server shutting down');
    }

    log.info('SSE Manager shut down');
  }
}
