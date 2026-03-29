import { createLogger } from '@mwashburn160/api-core';

const logger = createLogger('ws-manager');

export interface WSClient {
  id: string;
  orgId: string;
  send(data: string): void;
  close(): void;
}

type MessageHandler = (client: WSClient, message: Record<string, unknown>) => void;

/**
 * WebSocket connection manager.
 * Manages authenticated WebSocket connections per org.
 * Works alongside SSE for backward compatibility.
 *
 * Requires a WebSocket library (ws) to be wired in at server startup.
 * This module provides the management layer only.
 */
export class WSManager {
  private clients = new Map<string, Set<WSClient>>();
  private handlers = new Map<string, MessageHandler>();
  private maxClientsPerOrg: number;

  constructor(options: { maxClientsPerOrg?: number } = {}) {
    this.maxClientsPerOrg = options.maxClientsPerOrg ?? 50;
  }

  addClient(client: WSClient): boolean {
    if (!this.clients.has(client.orgId)) {
      this.clients.set(client.orgId, new Set());
    }
    const orgClients = this.clients.get(client.orgId)!;
    if (orgClients.size >= this.maxClientsPerOrg) {
      logger.warn('Max WebSocket clients reached for org', { orgId: client.orgId });
      return false;
    }
    orgClients.add(client);
    logger.debug('WebSocket client connected', { orgId: client.orgId, clientId: client.id, total: orgClients.size });
    return true;
  }

  removeClient(client: WSClient): void {
    const orgClients = this.clients.get(client.orgId);
    if (orgClients) {
      orgClients.delete(client);
      if (orgClients.size === 0) this.clients.delete(client.orgId);
    }
  }

  onMessage(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  handleMessage(client: WSClient, raw: string): void {
    try {
      const msg = JSON.parse(raw) as { type?: string; [key: string]: unknown };
      if (!msg.type) return;
      const handler = this.handlers.get(msg.type);
      if (handler) handler(client, msg);
    } catch {
      logger.debug('Invalid WebSocket message', { clientId: client.id });
    }
  }

  sendToOrg(orgId: string, type: string, data: unknown): number {
    const orgClients = this.clients.get(orgId);
    if (!orgClients) return 0;
    const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
    let sent = 0;
    for (const client of orgClients) {
      try { client.send(payload); sent++; } catch { this.removeClient(client); }
    }
    return sent;
  }

  broadcast(type: string, data: unknown): number {
    let sent = 0;
    for (const [, orgClients] of this.clients) {
      const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
      for (const client of orgClients) {
        try { client.send(payload); sent++; } catch { this.removeClient(client); }
      }
    }
    return sent;
  }

  getStats(): { orgs: number; clients: number } {
    let clients = 0;
    for (const [, orgClients] of this.clients) clients += orgClients.size;
    return { orgs: this.clients.size, clients };
  }
}

export function createWSManager(options?: { maxClientsPerOrg?: number }): WSManager {
  return new WSManager(options);
}
