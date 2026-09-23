// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared S3-compatible client, and the bucket-ensure backstop that goes
 * with it.
 *
 * Backed by MinIO in every environment (self-hosted, no AWS-account coupling);
 * because MinIO speaks the S3 API this uses the AWS S3 SDK, so a real-S3 swap is
 * a pure config change (drop the custom endpoint + path-style, supply IAM creds).
 *
 * Config (env) — one set of names, read identically by every service; each
 * container is pointed at its OWN bucket with bucket-scoped credentials:
 *   S3_ENDPOINT           MinIO/S3 endpoint URL (e.g. http://minio:9000). Empty
 *                         ⇒ default AWS S3 (no custom endpoint).
 *   S3_REGION             region (default 'us-east-1').
 *   S3_ACCESS_KEY_ID      access key.
 *   S3_SECRET_ACCESS_KEY  secret key.
 *   S3_FORCE_PATH_STYLE   'true' for MinIO (path-style addressing); default true.
 *
 * `S3_BUCKET` is deliberately NOT read here: the bucket is the caller's, and
 * each service keeps its own default and its own key convention.
 *
 * **Reached through the `@pipeline-builder/api-core/s3` subpath, never the root
 * barrel** — only two services do blob storage, and the S3 SDK is a large
 * eager dependency that the other eight must not pay for at boot. Same reason
 * `@aws-sdk/client-kms` is dynamically imported inside secret-encryption.
 */

import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

import { envBool, envStr } from '../utils/env.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('s3-client');

let client: S3Client | null = null;

/**
 * The process-wide S3 client, built from env on first use.
 *
 * Lazy so a service that never touches blob storage — and a test that never
 * configures S3 — never constructs one.
 */
export function s3Client(): S3Client {
  if (client) return client;
  const endpoint = envStr('S3_ENDPOINT', '');
  client = new S3Client({
    region: envStr('S3_REGION', 'us-east-1'),
    ...(endpoint ? { endpoint } : {}),
    // Path-style is required by MinIO (no virtual-host bucket DNS). Harmless
    // against real S3, but default-on here because MinIO is the default backend.
    forcePathStyle: envBool('S3_FORCE_PATH_STYLE', true),
    credentials: {
      accessKeyId: envStr('S3_ACCESS_KEY_ID', 'minioadmin'),
      secretAccessKey: envStr('S3_SECRET_ACCESS_KEY', 'minioadmin'),
    },
  });
  return client;
}

/** In-flight / settled ensure per bucket. A rejected attempt is never left here. */
const bucketsReady = new Map<string, Promise<void>>();

/**
 * Ensure `bucket` exists, once per process per bucket.
 *
 * MinIO — unlike an auto-provisioned S3 bucket — won't create a bucket on first
 * write, so HEAD it and CREATE on 404/NoSuchBucket. Idempotent and
 * concurrency-safe: concurrent callers share the single in-flight promise.
 *
 * The important part is the failure branch. A CreateBucket failure is EITHER a
 * benign race (another replica created it between our HEAD and our CREATE) or a
 * real outage (MinIO not up yet, credentials wrong, network down). Re-HEADing
 * tells them apart:
 *
 *  - it now exists  → benign race, continue;
 *  - it still does not → DROP the memo entry and fail this attempt.
 *
 * Dropping the entry is load-bearing. Memoizing a resolved "ready" after a
 * failed create caches a permanently-broken success for the process lifetime:
 * every later upload then fails `NoSuchBucket` against a MinIO that came up
 * seconds after boot, until the pod is restarted.
 */
export async function ensureBucket(bucket: string): Promise<void> {
  let ready = bucketsReady.get(bucket);
  if (!ready) {
    ready = (async () => {
      try {
        await s3Client().send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        try {
          await s3Client().send(new CreateBucketCommand({ Bucket: bucket }));
          logger.info('Created S3 bucket', { bucket });
        } catch (err) {
          try {
            await s3Client().send(new HeadBucketCommand({ Bucket: bucket }));
            logger.warn('S3 bucket ensure race (now exists, continuing)', { bucket, error: String(err) });
          } catch {
            bucketsReady.delete(bucket);
            throw new Error(`S3 bucket "${bucket}" unavailable: ${String(err)}`);
          }
        }
      }
    })();
    bucketsReady.set(bucket, ready);
  }
  return ready;
}
