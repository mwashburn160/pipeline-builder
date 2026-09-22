// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * services/attachment-service.ts — the attachment rows behind message uploads.
 * Pins the queries' SCOPE: a pending attachment links only to its own
 * uploader's, own-org, still-unlinked rows (no stealing another user's upload
 * into your message); lookups short-circuit on empty input; the pending purge
 * deletes only unlinked rows older than the TTL and removes their blobs.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { drizzleMock, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('drizzle-orm', () => drizzleMock({
  and: (...p: unknown[]) => ({ and: p }),
  eq: (c: unknown, v: unknown) => ({ eq: [c, v] }),
  inArray: (c: unknown, v: unknown) => ({ inArray: [c, v] }),
  isNull: (c: unknown) => ({ isNull: c }),
  lt: (c: unknown, v: unknown) => ({ lt: [c, v] }),
}));

const T = { id: 'id', orgId: 'org_id', uploadedBy: 'uploaded_by', messageId: 'message_id', createdAt: 'created_at', storageKey: 'storage_key' };

/** A chainable fake tx: records each call; awaiting the chain yields the next queued result. */
const calls: Array<[string, unknown[]]> = [];
const results: unknown[][] = [];
function chain(): unknown {
  const target = {} as Record<string, unknown>;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        const value = results.shift() ?? [];
        return (res: (v: unknown) => unknown) => Promise.resolve(value).then(res);
      }
      return (...args: unknown[]) => { calls.push([String(prop), args]); return chain(); };
    },
  });
}
const withTenantTx = jest.fn<AnyFn>(async (fn: (tx: unknown) => unknown) => fn(chain()));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { messageAttachment: T },
  withTenantTx,
}));
const deleteAttachments = jest.fn<AnyFn>(async () => undefined);
const deleteAttachmentsByOrgPrefix = jest.fn<AnyFn>(async () => 4);
jest.unstable_mockModule('../src/services/attachment-storage.js', () => ({ deleteAttachments, deleteAttachmentsByOrgPrefix }));

const { AttachmentService } = await import('../src/services/attachment-service.js');
const svc = new AttachmentService();

const where = () => calls.find(([m]) => m === 'where')?.[1][0];

beforeEach(() => {
  calls.length = 0;
  results.length = 0;
  jest.clearAllMocks();
  delete process.env.MESSAGE_ATTACHMENT_PENDING_TTL_HOURS;
});

describe('AttachmentService', () => {
  it('creates a PENDING row (no message yet)', async () => {
    results.push([{ id: 'a1' }]);
    await expect(svc.createPending({ orgId: 'o', uploadedBy: 'u', filename: 'f', contentType: 'text/plain', sizeBytes: 1, storageKey: 'k' })).resolves.toEqual({ id: 'a1' });
    expect(calls.find(([m]) => m === 'values')![1][0]).toMatchObject({ messageId: null, uploadedBy: 'u' });
  });

  it('finds by id (null when absent), by message and by messages', async () => {
    results.push([]);
    await expect(svc.findById('x')).resolves.toBeNull();
    expect(where()).toEqual({ eq: ['id', 'x'] });
    results.push([{ id: 'a' }]);
    await expect(svc.findByMessageId('m1')).resolves.toEqual([{ id: 'a' }]);
    results.push([{ id: 'b' }]);
    await expect(svc.findByMessageIds(['m1', 'm2'])).resolves.toEqual([{ id: 'b' }]);
  });

  it('short-circuits empty id lists without touching the database', async () => {
    await expect(svc.findByMessageIds([])).resolves.toEqual([]);
    await expect(svc.linkToMessage([], 'm1', 'org', 'u')).resolves.toEqual([]);
    expect(withTenantTx).not.toHaveBeenCalled();
  });

  it('links only the caller\'s own, own-org, still-pending uploads', async () => {
    results.push([{ id: 'a1', messageId: 'm1' }]);
    await svc.linkToMessage(['a1', 'a2'], 'm1', 'ORG-1', 'user-1');
    expect(calls.find(([m]) => m === 'set')![1][0]).toEqual({ messageId: 'm1' });
    expect(where()).toEqual({
      and: [
        { inArray: ['id', ['a1', 'a2']] },
        { eq: ['org_id', 'org-1'] },
        { eq: ['uploaded_by', 'user-1'] },
        { isNull: 'message_id' },
      ],
    });
  });

  it('purges only unlinked rows older than the TTL, then their blobs', async () => {
    process.env.MESSAGE_ATTACHMENT_PENDING_TTL_HOURS = '2';
    const now = new Date('2026-09-21T12:00:00Z');
    results.push([{ id: 'a1', storageKey: 'k1' }, { id: 'a2', storageKey: 'k2' }], []);
    await expect(svc.purgePending(now, 10)).resolves.toBe(2);
    expect(where()).toEqual({ and: [{ isNull: 'message_id' }, { lt: ['created_at', new Date('2026-09-21T10:00:00Z')] }] });
    expect(calls.find(([m]) => m === 'limit')![1][0]).toBe(10);
    expect(calls.filter(([m]) => m === 'delete')).toHaveLength(1);
    expect(deleteAttachments).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('a nothing-expired purge deletes nothing; a bad TTL falls back to 24 h', async () => {
    process.env.MESSAGE_ATTACHMENT_PENDING_TTL_HOURS = 'soon';
    const now = new Date('2026-09-21T12:00:00Z');
    results.push([]);
    await expect(svc.purgePending(now)).resolves.toBe(0);
    expect(where()).toEqual({ and: [{ isNull: 'message_id' }, { lt: ['created_at', new Date('2026-09-20T12:00:00Z')] }] });
    expect(calls.find(([m]) => m === 'limit')![1][0]).toBe(500);
    expect(calls.some(([m]) => m === 'delete')).toBe(false);
    expect(deleteAttachments).toHaveBeenCalledWith([]);
  });

  it('purges an org\'s blobs by prefix', async () => {
    await expect(svc.purgeOrgBlobs('org-1')).resolves.toBe(4);
    expect(deleteAttachmentsByOrgPrefix).toHaveBeenCalledWith('org-1');
  });
});
