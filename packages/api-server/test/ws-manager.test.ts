// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('@pipeline-builder/api-core', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { WSManager, createWSManager, WSClient } from '../src/http/ws-manager';

function fakeClient(orgId: string, id = 'c-' + Math.random()): WSClient {
  return {
    id,
    orgId,
    send: jest.fn(),
    close: jest.fn(),
  };
}

describe('WSManager', () => {
  describe('createWSManager', () => {
    it('returns a WSManager instance', () => {
      expect(createWSManager()).toBeInstanceOf(WSManager);
    });

    it('forwards options', () => {
      const manager = createWSManager({ maxClientsPerOrg: 2 });
      expect(manager.addClient(fakeClient('org-1'))).toBe(true);
      expect(manager.addClient(fakeClient('org-1'))).toBe(true);
      expect(manager.addClient(fakeClient('org-1'))).toBe(false);
    });
  });

  describe('addClient / removeClient', () => {
    it('adds a client and returns true', () => {
      const manager = new WSManager();
      expect(manager.addClient(fakeClient('org-1'))).toBe(true);
      expect(manager.getStats().clients).toBe(1);
    });

    it('rejects when max clients reached for an org', () => {
      const manager = new WSManager({ maxClientsPerOrg: 1 });
      expect(manager.addClient(fakeClient('org-1'))).toBe(true);
      expect(manager.addClient(fakeClient('org-1'))).toBe(false);
    });

    it('removes a client and cleans up empty org buckets', () => {
      const manager = new WSManager();
      const client = fakeClient('org-1');
      manager.addClient(client);
      manager.removeClient(client);
      expect(manager.getStats().orgs).toBe(0);
    });
  });

  describe('sendToOrg', () => {
    it('returns 0 when no clients in org', () => {
      const manager = new WSManager();
      expect(manager.sendToOrg('nope', 'evt', {})).toBe(0);
    });

    it('sends payload to every client in org', () => {
      const manager = new WSManager();
      const c1 = fakeClient('org-1');
      const c2 = fakeClient('org-1');
      manager.addClient(c1);
      manager.addClient(c2);
      const sent = manager.sendToOrg('org-1', 'msg', { v: 1 });
      expect(sent).toBe(2);
      expect(c1.send).toHaveBeenCalledWith(expect.stringContaining('"type":"msg"'));
    });

    it('removes client and continues when send throws', () => {
      const manager = new WSManager();
      const broken = fakeClient('org-1');
      (broken.send as jest.Mock).mockImplementation(() => { throw new Error('closed'); });
      const ok = fakeClient('org-1');
      manager.addClient(broken);
      manager.addClient(ok);
      const sent = manager.sendToOrg('org-1', 'msg', null);
      expect(sent).toBe(1);
    });
  });

  describe('broadcast', () => {
    it('returns 0 when no clients', () => {
      expect(new WSManager().broadcast('evt', null)).toBe(0);
    });

    it('sends to all clients across orgs', () => {
      const manager = new WSManager();
      manager.addClient(fakeClient('org-1'));
      manager.addClient(fakeClient('org-2'));
      expect(manager.broadcast('global', { x: 1 })).toBe(2);
    });
  });

  describe('handleMessage', () => {
    it('routes message to handler when type matches', () => {
      const manager = new WSManager();
      const handler = jest.fn();
      manager.onMessage('ping', handler);
      const client = fakeClient('org-1');
      manager.handleMessage(client, JSON.stringify({ type: 'ping', n: 1 }));
      expect(handler).toHaveBeenCalledWith(client, expect.objectContaining({ type: 'ping', n: 1 }));
    });

    it('ignores invalid JSON without throwing', () => {
      const manager = new WSManager();
      expect(() => manager.handleMessage(fakeClient('org-1'), 'not-json')).not.toThrow();
    });

    it('ignores messages without a type', () => {
      const manager = new WSManager();
      const handler = jest.fn();
      manager.onMessage('ping', handler);
      manager.handleMessage(fakeClient('org-1'), JSON.stringify({ data: 'noop' }));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('counts orgs and clients', () => {
      const manager = new WSManager();
      manager.addClient(fakeClient('org-1'));
      manager.addClient(fakeClient('org-1'));
      manager.addClient(fakeClient('org-2'));
      expect(manager.getStats()).toEqual({ orgs: 2, clients: 3 });
    });
  });
});
