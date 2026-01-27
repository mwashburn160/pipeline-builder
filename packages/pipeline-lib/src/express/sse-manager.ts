import { Response } from 'express';
import { v7 as uuid } from 'uuid';

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
 * SSE client type
 */
export interface SSEClient {
  id: string;
  res: Response;
}

/**
 * SSE helper class
 * Handles clients per requestId and sending messages
 */
export class SSEManager {
  private clients = new Map<string, SSEClient[]>();

  /**
   * Adds a client to the SSE manager
   * @param requestId - Unique request ID
   * @param res - Express Response object
   */
  addClient(requestId: string, res: Response) {
    const client: SSEClient = { id: uuid(), res };
    const existing = this.clients.get(requestId) || [];
    existing.push(client);
    this.clients.set(requestId, existing);

    // Handle disconnection
    res.on('close', () => {
      const remaining = (this.clients.get(requestId) || []).filter(c => c.id !== client.id);
      if (remaining.length === 0) {
        this.clients.delete(requestId);
      } else {
        this.clients.set(requestId, remaining);
      }
    });
  }

  /**
   * Sends a message to all SSE clients for a requestId
   * @param requestId - Request ID
   * @param type - Event type
   * @param message - Message string
   * @param data - Optional additional data
   */
  send(requestId: string, type: SSEEventType, message: string, data?: unknown) {
    const payload: SSEPayload = {
      ts: new Date().toISOString(),
      type,
      message,
      data,
    };

    const clients = this.clients.get(requestId) || [];
    for (const client of clients) {
      client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
  }

  /**
   * Middleware to initialize SSE connection
   * Usage: app.get('/logs/:requestId', sseManager.middleware());
   */
  middleware() {
    return (req: any, res: Response) => {
      const { requestId } = req.params;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      this.addClient(requestId, res);
    };
  }
}