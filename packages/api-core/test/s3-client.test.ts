// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared S3/MinIO client and bucket-ensure backstop (services/s3-client.ts),
 * reached in production through the `@pipeline-builder/api-core/s3` subpath.
 *
 * The branches that matter are the ensure's FAILURE branches, which were a live
 * bug once: memoizing a resolved "ready" after a failed CreateBucket cached a
 * permanently-broken success for the process lifetime, and every later upload
 * failed `NoSuchBucket` against a MinIO that came up seconds after boot. A
 * benign create race and a real outage start identically and are told apart
 * only by the re-HEAD, so both are pinned here.
 *
 * The ensure memo is module-level, so each case loads a fresh module.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

type Cmd = { __type: string; input: Record<string, unknown> };

const sent: Cmd[] = [];
const clientConfigs: unknown[] = [];
// An entry may be a function so a case can vary the outcome across calls — the
// ensure race and a real outage differ only in the SECOND HeadBucket.
let failOn: Record<string, Error | (() => Error | undefined) | undefined> = {};

const cmd = (type: string) => class {
  __type = type;
  constructor(public input: Record<string, unknown>) {}
};

/** Load a fresh copy of the module with the S3 SDK stubbed. */
async function loadS3(): Promise<typeof import('../src/services/s3-client.js')> {
  jest.resetModules();
  jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
    S3Client: class {
      constructor(cfg: unknown) { clientConfigs.push(cfg); }
      async send(c: Cmd) {
        sent.push(c);
        const entry = failOn[c.__type];
        const err = typeof entry === 'function' ? entry() : entry;
        if (err) throw err;
        return {};
      }
    },
    HeadBucketCommand: cmd('HeadBucket'),
    CreateBucketCommand: cmd('CreateBucket'),
  }));
  jest.unstable_mockModule('../src/utils/logger.js', () => ({
    createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  }));
  return import('../src/services/s3-client.js');
}

beforeEach(() => {
  sent.length = 0;
  clientConfigs.length = 0;
  failOn = {};
  delete process.env.S3_ENDPOINT;
});

describe('s3Client', () => {
  it('builds ONE client, lazily, from the S3_* env names', async () => {
    process.env.S3_ENDPOINT = 'http://minio:9000';
    const { s3Client } = await loadS3();
    // Nothing constructed until someone actually asks for the client.
    expect(clientConfigs).toHaveLength(0);

    const first = s3Client();
    expect(first).toBe(s3Client());
    expect(clientConfigs).toHaveLength(1);
    expect(clientConfigs[0]).toMatchObject({
      region: 'us-east-1',
      endpoint: 'http://minio:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    });
  });

  it('omits the endpoint entirely against real S3 (no S3_ENDPOINT)', async () => {
    // An empty `endpoint` is not the same as an absent one — the SDK would take
    // it literally and fail to resolve a host.
    const { s3Client } = await loadS3();
    s3Client();
    expect(clientConfigs[0]).not.toHaveProperty('endpoint');
  });
});

describe('ensureBucket', () => {
  it('creates a missing bucket once; later calls are memoized', async () => {
    const { ensureBucket } = await loadS3();
    failOn.HeadBucket = new Error('NoSuchBucket');

    await ensureBucket('plugins');
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket', 'CreateBucket']);
    expect(sent[1].input).toEqual({ Bucket: 'plugins' });

    sent.length = 0;
    await ensureBucket('plugins');
    expect(sent).toHaveLength(0);
  });

  it('does nothing beyond the HEAD when the bucket already exists', async () => {
    const { ensureBucket } = await loadS3();
    await ensureBucket('message-attachments');
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket']);
  });

  it('memoizes PER BUCKET (the plugin service ensures two)', async () => {
    const { ensureBucket } = await loadS3();
    await ensureBucket('plugins');
    await ensureBucket('plugin-quarantine');
    await ensureBucket('plugins');
    expect(sent.map((c) => c.input.Bucket)).toEqual(['plugins', 'plugin-quarantine']);
  });

  it('shares one in-flight ensure between concurrent callers', async () => {
    const { ensureBucket } = await loadS3();
    await Promise.all([ensureBucket('plugins'), ensureBucket('plugins'), ensureBucket('plugins')]);
    expect(sent).toHaveLength(1);
  });

  it('continues when CreateBucket lost a benign race (the bucket now exists)', async () => {
    const { ensureBucket } = await loadS3();
    let heads = 0;
    failOn.HeadBucket = () => (++heads === 1 ? new Error('NoSuchBucket') : undefined);
    failOn.CreateBucket = new Error('BucketAlreadyOwnedByYou');

    await expect(ensureBucket('plugins')).resolves.toBeUndefined();
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket', 'CreateBucket', 'HeadBucket']);
  });

  it('does NOT memoize a real outage — a later call retries the ensure', async () => {
    const { ensureBucket } = await loadS3();
    failOn.HeadBucket = new Error('ECONNREFUSED');
    failOn.CreateBucket = new Error('ECONNREFUSED');

    await expect(ensureBucket('plugins')).rejects.toThrow('S3 bucket "plugins" unavailable');

    // MinIO comes up. Without the memo reset this would keep a resolved "ready"
    // and every later upload would fail NoSuchBucket for the process lifetime.
    sent.length = 0;
    failOn = {};
    await ensureBucket('plugins');
    expect(sent.map((c) => c.__type)).toEqual(['HeadBucket']);
  });

  it('names the bucket in the outage error', async () => {
    const { ensureBucket } = await loadS3();
    failOn.HeadBucket = new Error('ECONNREFUSED');
    failOn.CreateBucket = new Error('boom');
    await expect(ensureBucket('plugin-quarantine'))
      .rejects.toThrow('S3 bucket "plugin-quarantine" unavailable: Error: boom');
  });
});
