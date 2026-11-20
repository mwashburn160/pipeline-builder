// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory S3 (RustFS) for suites that exercise real object-storage flows:
 * buckets of objects with ETags, server-side copy honouring
 * `CopySourceIfMatch`, paged `ListObjectsV2`, `DeleteObjects` (with per-key
 * failure injection), and the bucket ensure calls. The suite mocks the SDK
 * with it BEFORE importing anything that reaches `@pipeline-builder/api-core/s3`:
 *
 *   jest.unstable_mockModule('@aws-sdk/client-s3', () => fakeS3Module(store));
 *
 * Unversioned like the plugin-sources bucket: a delete leaves nothing behind.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface FakeObject { body: Buffer; etag: string; contentType?: string }

export interface FakeS3Store {
  buckets: Map<string, Map<string, FakeObject>>;
  /** Command names sent, in order (`Put`, `Get`, `Copy`, `List`, `DeleteObjects`, …). */
  sent: Array<{ type: string; input: Record<string, unknown> }>;
  /** Fail the next send of a command type with this error (one shot each). */
  failNext: Map<string, Error>;
  /** Fail every send of a command type while set. */
  failAlways: Map<string, Error>;
  /** Keys DeleteObjects reports as not deleted. */
  undeletable: Set<string>;
  put(bucket: string, key: string, body: string | Buffer): FakeObject;
  get(bucket: string, key: string): FakeObject | undefined;
  keys(bucket: string): string[];
  reset(): void;
}

export function createFakeS3Store(): FakeS3Store {
  const store: FakeS3Store = {
    buckets: new Map(),
    sent: [],
    failNext: new Map(),
    failAlways: new Map(),
    undeletable: new Set(),
    put(bucket, key, body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const obj = { body: buf, etag: `"${createHash('md5').update(buf).digest('hex')}"` };
      if (!store.buckets.has(bucket)) store.buckets.set(bucket, new Map());
      store.buckets.get(bucket)!.set(key, obj);
      return obj;
    },
    get(bucket, key) {
      return store.buckets.get(bucket)?.get(key);
    },
    keys(bucket) {
      return [...(store.buckets.get(bucket)?.keys() ?? [])].sort();
    },
    reset() {
      store.buckets.clear();
      store.sent.length = 0;
      store.failNext.clear();
      store.failAlways.clear();
      store.undeletable.clear();
    },
  };
  return store;
}

const named = (name: string, message = name) => Object.assign(new Error(message), { name });

async function toBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/** The `@aws-sdk/client-s3` module, backed by `store`. */
export function fakeS3Module(store: FakeS3Store): Record<string, unknown> {
  const cmd = (type: string) => class {
    readonly __type = type;
    constructor(public input: Record<string, any>) {}
  };
  const handlers: Record<string, (input: Record<string, any>) => Promise<unknown>> = {
    HeadBucket: async (i) => {
      if (!store.buckets.has(i.Bucket)) throw named('NotFound');
      return {};
    },
    CreateBucket: async (i) => {
      if (!store.buckets.has(i.Bucket)) store.buckets.set(i.Bucket, new Map());
      return {};
    },
    Put: async (i) => {
      const obj = store.put(i.Bucket, i.Key, await toBuffer(i.Body));
      obj.contentType = i.ContentType;
      return { ETag: obj.etag };
    },
    Get: async (i) => {
      const obj = store.get(i.Bucket, i.Key);
      if (!obj) throw named('NoSuchKey', 'The specified key does not exist.');
      return { Body: Readable.from([obj.body]), ETag: obj.etag, ContentLength: obj.body.length };
    },
    Copy: async (i) => {
      const src = String(i.CopySource);
      const slash = src.indexOf('/');
      const bucket = src.slice(0, slash);
      const key = src.slice(slash + 1).split('/').map(decodeURIComponent).join('/');
      const obj = store.get(bucket, key);
      if (!obj) throw named('NoSuchKey');
      if (i.CopySourceIfMatch && i.CopySourceIfMatch !== obj.etag) throw named('PreconditionFailed');
      if (!store.buckets.has(i.Bucket)) throw named('NoSuchBucket');
      const copy = store.put(i.Bucket, i.Key, obj.body);
      copy.contentType = i.ContentType;
      return { CopyObjectResult: { ETag: copy.etag } };
    },
    Delete: async (i) => {
      store.buckets.get(i.Bucket)?.delete(i.Key);
      return {};
    },
    DeleteObjects: async (i) => {
      const errors: Array<{ Key: string; Code: string }> = [];
      for (const { Key } of i.Delete.Objects as Array<{ Key: string }>) {
        if (store.undeletable.has(Key)) errors.push({ Key, Code: 'AccessDenied' });
        else store.buckets.get(i.Bucket)?.delete(Key);
      }
      return errors.length ? { Errors: errors } : {};
    },
    List: async (i) => {
      const all = store.keys(i.Bucket).filter((k) => k.startsWith(i.Prefix ?? ''));
      const start = i.ContinuationToken ? Number(i.ContinuationToken) : 0;
      const max = i.MaxKeys ?? 1000;
      const page = all.slice(start, start + max);
      const more = start + max < all.length;
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: more, ...(more ? { NextContinuationToken: String(start + max) } : {}) };
    },
  };
  return {
    S3Client: class {
      constructor(_cfg: unknown) {}
      async send(c: { __type: string; input: Record<string, unknown> }) {
        store.sent.push({ type: c.__type, input: c.input });
        const once = store.failNext.get(c.__type);
        if (once) {
          store.failNext.delete(c.__type);
          throw once;
        }
        const always = store.failAlways.get(c.__type);
        if (always) throw always;
        return handlers[c.__type]!(c.input as Record<string, any>);
      }
    },
    HeadBucketCommand: cmd('HeadBucket'),
    CreateBucketCommand: cmd('CreateBucket'),
    PutObjectCommand: cmd('Put'),
    GetObjectCommand: cmd('Get'),
    CopyObjectCommand: cmd('Copy'),
    DeleteObjectCommand: cmd('Delete'),
    DeleteObjectsCommand: cmd('DeleteObjects'),
    ListObjectsV2Command: cmd('List'),
  };
}
