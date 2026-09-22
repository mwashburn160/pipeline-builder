// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chain-head export to write-once storage + the SigV4 signer it rides on.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mockConfig } from './helpers/config-mock.js';
import { apiCoreMock } from './helpers/mock-api-core.js';
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

process.env.AUDIT_CHAIN_HMAC_KEY = 'test-audit-chain-hmac-key-0123456789abcdef';

const headCfg = {
  endpoint: 'http://minio:9000',
  bucket: 'audit-heads',
  region: 'us-east-1',
  accessKeyId: 'AKTEST',
  secretAccessKey: 'secret',
  prefix: 'audit-heads',
  lockMode: 'COMPLIANCE' as const,
  retentionDays: 400,
  intervalMs: 300_000,
};
jest.unstable_mockModule('../src/config/index.js', () => mockConfig({ audit: { retentionDays: 90, headExport: headCfg } }));

let heads: Array<{ _id: string; seq: number; hash: string; headCreatedAt: Date; exportedSeq?: number }> = [];
const mockHeadUpdateOne = jest.fn(async (filter: { _id: string }, update: { $set: { exportedSeq: number } }) => {
  const h = heads.find((x) => x._id === filter._id);
  if (h) h.exportedSeq = update.$set.exportedSeq;
  return {};
});
jest.unstable_mockModule('../src/models/audit-chain-head.js', () => ({
  __esModule: true,
  default: {
    find: () => ({ select: () => ({ lean: async () => heads.filter((h) => h.seq > (h.exportedSeq ?? 0)) }) }),
    updateOne: (...a: [never, never]) => mockHeadUpdateOne(...a),
  },
}));
jest.unstable_mockModule('../src/models/audit-event.js', () => ({ __esModule: true, default: {} }));

const { exportAuditChainHeads, fetchPublishedHead, signHead } = await import('../src/services/audit-head-export.js');
const { PublishedHeadInvalidError } = await import('../src/helpers/audit-chain.js');
const { signV4 } = await import('../src/utils/s3-sigv4.js');

/** A fake S3 (path-style) keeping every PUT; GET serves the latest body. */
let objects = new Map<string, { body: string; headers: Record<string, string> }>();
const realFetch = globalThis.fetch;
beforeEach(() => {
  heads = [];
  objects = new Map();
  mockHeadUpdateOne.mockClear();
  globalThis.fetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => {
    const path = new URL(url).pathname;
    if (init.method === 'PUT') {
      objects.set(path, { body: init.body!.toString('utf-8'), headers: init.headers });
      return new Response('', { status: 200 });
    }
    const o = objects.get(path);
    return o ? new Response(o.body, { status: 200 }) : new Response('NoSuchKey', { status: 404 });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('signV4', () => {
  it('reproduces the AWS-documented S3 GET example signature', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object)
    const h = signV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});

describe('exportAuditChainHeads', () => {
  it('publishes each advanced head (per-seq object + latest) with Object Lock retention, then marks it exported', async () => {
    heads = [{ _id: 'org-1', seq: 7, hash: 'a'.repeat(64), headCreatedAt: new Date('2026-09-21T00:00:00Z') }];
    const now = new Date('2026-09-21T01:00:00Z');

    const res = await exportAuditChainHeads(headCfg, () => now);

    expect(res).toEqual({ exported: 1, failed: 0 });
    const seqObj = objects.get('/audit-heads/audit-heads/org-1/000000000007.json')!;
    const latest = objects.get('/audit-heads/audit-heads/org-1/latest.json')!;
    expect(seqObj).toBeDefined();
    expect(latest.body).toBe(seqObj.body);
    expect(latest.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    expect(latest.headers['x-amz-object-lock-retain-until-date']).toBe(new Date(now.getTime() + 400 * 86_400_000).toISOString());
    expect(latest.headers['content-md5']).toBeDefined();
    expect(latest.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKTEST\//);
    const body = JSON.parse(latest.body);
    expect(body).toMatchObject({ v: 1, chainKey: 'org-1', seq: 7, hash: 'a'.repeat(64) });
    const { sig, ...payload } = body;
    expect(sig).toBe(signHead(payload));
    expect(heads[0].exportedSeq).toBe(7);

    // Nothing advanced → the next pass ships nothing.
    expect(await exportAuditChainHeads(headCfg, () => now)).toEqual({ exported: 0, failed: 0 });
  });

  it('omits lock headers when the target has no Object Lock support', async () => {
    heads = [{ _id: 'org-1', seq: 1, hash: 'b'.repeat(64), headCreatedAt: new Date() }];
    await exportAuditChainHeads({ ...headCfg, lockMode: 'none' });
    expect(objects.get('/audit-heads/audit-heads/org-1/latest.json')!.headers['x-amz-object-lock-mode']).toBeUndefined();
  });

  it('keeps a head un-exported (retried next pass) when a PUT fails', async () => {
    heads = [{ _id: 'org-1', seq: 2, hash: 'c'.repeat(64), headCreatedAt: new Date() }];
    globalThis.fetch = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    expect(await exportAuditChainHeads(headCfg)).toEqual({ exported: 0, failed: 1 });
    expect(mockHeadUpdateOne).not.toHaveBeenCalled();
  });

  it('is a no-op when the export target is not configured', async () => {
    heads = [{ _id: 'org-1', seq: 2, hash: 'c'.repeat(64), headCreatedAt: new Date() }];
    expect(await exportAuditChainHeads({ ...headCfg, endpoint: '' })).toEqual({ exported: 0, failed: 0 });
    expect(objects.size).toBe(0);
  });
});

describe('fetchPublishedHead', () => {
  it('round-trips an exported head', async () => {
    heads = [{ _id: 'org-9', seq: 4, hash: 'd'.repeat(64), headCreatedAt: new Date('2026-09-20T00:00:00Z') }];
    await exportAuditChainHeads(headCfg);
    expect(await fetchPublishedHead('org-9', headCfg)).toMatchObject({ seq: 4, hash: 'd'.repeat(64), headCreatedAt: '2026-09-20T00:00:00.000Z' });
  });

  it('returns null when nothing was published for the chain', async () => {
    expect(await fetchPublishedHead('org-none', headCfg)).toBeNull();
  });

  it('rejects a head whose signature does not verify (bucket creds alone cannot forge one)', async () => {
    heads = [{ _id: 'org-9', seq: 4, hash: 'd'.repeat(64), headCreatedAt: new Date() }];
    await exportAuditChainHeads(headCfg);
    const key = '/audit-heads/audit-heads/org-9/latest.json';
    const forged = { ...JSON.parse(objects.get(key)!.body), seq: 2 };
    objects.set(key, { body: JSON.stringify(forged), headers: {} });
    await expect(fetchPublishedHead('org-9', headCfg)).rejects.toBeInstanceOf(PublishedHeadInvalidError);
  });

  it("rejects another chain's head replayed under this chain", async () => {
    heads = [{ _id: 'org-a', seq: 9, hash: 'e'.repeat(64), headCreatedAt: new Date() }];
    await exportAuditChainHeads(headCfg);
    objects.set('/audit-heads/audit-heads/org-b/latest.json', objects.get('/audit-heads/audit-heads/org-a/latest.json')!);
    await expect(fetchPublishedHead('org-b', headCfg)).rejects.toBeInstanceOf(PublishedHeadInvalidError);
  });
});
