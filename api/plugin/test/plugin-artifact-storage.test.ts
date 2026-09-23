// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/plugin-artifact-storage — the S3/MinIO staging of plugin
 * build contexts. The S3 SDK is stubbed; these pin the key shape, the
 * create-bucket-once backstop, the streamed download and best-effort delete.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { jest, describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

type Cmd = { __type: string; input: Record<string, unknown> };
const sent: Cmd[] = [];
// An entry may be a function so a test can vary the outcome across calls — the
// bucket-ensure race and a real outage differ only in the SECOND HeadBucket.
let failOn: Record<string, Error | (() => Error | undefined) | undefined> = {};
let getBody: () => unknown = () => Readable.from([Buffer.from('zip-bytes')]);
const clientConfigs: unknown[] = [];

const cmd = (type: string) => class {
  __type = type;
  constructor(public input: Record<string, unknown>) {}
};

jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(cfg: unknown) { clientConfigs.push(cfg); }
    async send(c: Cmd) {
      sent.push(c);
      const entry = failOn[c.__type];
      const err = typeof entry === 'function' ? entry() : entry;
      if (err) throw err;
      return c.__type === 'Get' ? { Body: getBody() } : {};
    }
  },
  PutObjectCommand: cmd('Put'),
  GetObjectCommand: cmd('Get'),
  DeleteObjectCommand: cmd('Delete'),
  HeadBucketCommand: cmd('HeadBucket'),
  CreateBucketCommand: cmd('CreateBucket'),
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  envStr: (name: string, def: string) => process.env[name] || def,
  envBool: (_name: string, def: boolean) => def,
}));

process.env.S3_ENDPOINT = 'http://minio:9000';
const storage = await import('../src/services/plugin-artifact-storage.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-artifact-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  sent.length = 0;
  failOn = {};
});

describe('pluginArtifactKey', () => {
  it('is <org, lowercased>/<requestId>.zip', () => {
    expect(storage.pluginArtifactKey('ORG-Acme', 'req-1')).toBe('org-acme/req-1.zip');
  });
});

describe('putPluginArtifact', () => {
  it('creates a missing bucket once, then writes the zip; later puts skip the check', async () => {
    failOn.HeadBucket = new Error('NoSuchBucket');
    await storage.putPluginArtifact('org/a.zip', Buffer.from('x'));
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket', 'CreateBucket', 'Put']);
    expect(sent[2].input).toMatchObject({ Bucket: 'plugins', Key: 'org/a.zip', ContentType: 'application/zip' });

    sent.length = 0;
    await storage.putPluginArtifact('org/b.zip', Buffer.from('y'));
    expect(sent.map((c) => c.__type)).toEqual(['Put']);
    // One client, pointed at the custom endpoint with path-style addressing.
    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).toMatchObject({ endpoint: 'http://minio:9000', forcePathStyle: true });
  });

  it('propagates a failed write (the caller must not enqueue the build)', async () => {
    failOn.Put = new Error('disk full');
    await expect(storage.putPluginArtifact('org/c.zip', Buffer.from('z'))).rejects.toThrow('disk full');
  });

  // The bucket-ensure memo is module-level, so these load a fresh copy to get an
  // unprimed one. Both start the same way — HEAD misses, CREATE fails — and are
  // told apart only by whether the bucket exists on the re-HEAD.
  it('continues when CreateBucket lost a benign race (the bucket now exists)', async () => {
    jest.resetModules();
    const fresh = await import('../src/services/plugin-artifact-storage.js');
    let heads = 0;
    failOn.HeadBucket = () => (++heads === 1 ? new Error('NoSuchBucket') : undefined);
    failOn.CreateBucket = new Error('BucketAlreadyOwnedByYou');

    await fresh.putPluginArtifact('org/race.zip', Buffer.from('x'));
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket', 'CreateBucket', 'HeadBucket', 'Put']);
  });

  it('does not memoize a real outage — a later call retries the ensure', async () => {
    jest.resetModules();
    const fresh = await import('../src/services/plugin-artifact-storage.js');
    failOn.HeadBucket = new Error('ECONNREFUSED');
    failOn.CreateBucket = new Error('ECONNREFUSED');

    await expect(fresh.putPluginArtifact('org/down.zip', Buffer.from('x')))
      .rejects.toThrow('S3 bucket "plugins" unavailable');

    // MinIO comes up. Without the reset the memo would hold a resolved "ready"
    // and every later upload would fail NoSuchBucket for the process lifetime.
    sent.length = 0;
    failOn = {};
    await fresh.putPluginArtifact('org/up.zip', Buffer.from('y'));
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket', 'Put']);
  });
});

describe('getPluginArtifactToFile', () => {
  it('streams the object to disk', async () => {
    const dest = path.join(tmp, 'ctx.zip');
    await storage.getPluginArtifactToFile('org/a.zip', dest);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('zip-bytes');
    expect(sent[0].input).toEqual({ Bucket: 'plugins', Key: 'org/a.zip' });
  });

  it('throws when the context is missing', async () => {
    failOn.Get = new Error('NoSuchKey');
    await expect(storage.getPluginArtifactToFile('org/none.zip', path.join(tmp, 'x.zip'))).rejects.toThrow('NoSuchKey');
  });
});

describe('deletePluginArtifact', () => {
  it('deletes the key', async () => {
    await storage.deletePluginArtifact('org/a.zip');
    expect(sent).toEqual([expect.objectContaining({ __type: 'Delete', input: { Bucket: 'plugins', Key: 'org/a.zip' } })]);
  });

  it('is a no-op without a key and never throws', async () => {
    await storage.deletePluginArtifact(undefined);
    expect(sent).toHaveLength(0);
    failOn.Delete = new Error('boom');
    await expect(storage.deletePluginArtifact('org/a.zip')).resolves.toBeUndefined();
  });
});
