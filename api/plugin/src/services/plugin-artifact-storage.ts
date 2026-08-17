// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * S3-compatible blob storage for the plugin BUILD CONTEXT (the uploaded ZIP).
 *
 * Why this exists: the upload handler and the build worker run in-process on
 * EVERY plugin replica, and BullMQ distributes a build job to any replica — so
 * the replica that BUILDS a plugin is often NOT the one that RECEIVED the
 * upload. Historically the two rendezvoused through a shared RWX filesystem
 * (EFS on EKS) holding the extracted context. Staging the upload ZIP in object
 * storage instead lets the build replica pull the context to its OWN local
 * scratch dir, so `plugins-data` can be a per-pod emptyDir (no shared EFS).
 *
 * Backed by MinIO in every environment (self-hosted, no AWS-account coupling);
 * because MinIO speaks the S3 API this uses the AWS S3 SDK, so a real-S3 swap is
 * a pure config change (drop the custom endpoint + path-style, supply IAM creds).
 *
 * Config (env) — same names the message service uses, set per-container to this
 * service's bucket + bucket-scoped creds:
 *   S3_ENDPOINT           MinIO/S3 endpoint URL (e.g. http://minio:9000). Empty
 *                         ⇒ default AWS S3 (no custom endpoint).
 *   S3_REGION             region (default 'us-east-1').
 *   S3_ACCESS_KEY_ID      access key.
 *   S3_SECRET_ACCESS_KEY  secret key.
 *   S3_BUCKET             bucket name (default 'plugins').
 *   S3_FORCE_PATH_STYLE   'true' for MinIO (path-style addressing); default true.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger, envStr, envBool } from '@pipeline-builder/api-core';

const logger = createLogger('plugin-artifact-storage');

/** Resolved bucket name — the single bucket all plugin build contexts live in. */
export const PLUGIN_ARTIFACT_BUCKET = envStr('S3_BUCKET', 'plugins');

/**
 * Deterministic key for a build-context blob: `<orgId>/<requestId>.zip`. The
 * requestId is unique per upload, so a key never collides across builds.
 */
export function pluginArtifactKey(orgId: string, requestId: string): string {
  return `${orgId.toLowerCase()}/${requestId}.zip`;
}

let client: S3Client | null = null;

/** Lazily build the shared S3 client from env (so tests can run without it). */
function s3(): S3Client {
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

let bucketReady: Promise<void> | null = null;

/**
 * Ensure the plugins bucket exists (memoized). MinIO — unlike an auto-provisioned
 * S3 bucket — won't create it on first write, so we HEAD it and CREATE on
 * 404/NoSuchBucket. Idempotent + concurrency-safe (single in-flight promise); a
 * benign "already exists" race is swallowed. (minio-init also pre-creates it, so
 * this is a belt-and-braces backstop for a fresh/real-S3 target.)
 */
async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      try {
        await s3().send(new HeadBucketCommand({ Bucket: PLUGIN_ARTIFACT_BUCKET }));
      } catch {
        try {
          await s3().send(new CreateBucketCommand({ Bucket: PLUGIN_ARTIFACT_BUCKET }));
          logger.info('Created plugins bucket', { bucket: PLUGIN_ARTIFACT_BUCKET });
        } catch (err) {
          // Another replica may have created it between our HEAD and CREATE.
          logger.warn('Plugins bucket ensure race (continuing)', { error: String(err) });
        }
      }
    })();
  }
  return bucketReady;
}

/** Upload a build-context ZIP. Throws on failure — the caller must not enqueue a
 *  build whose context never reached durable storage (a cross-pod build would
 *  then fail to materialize it). */
export async function putPluginArtifact(key: string, body: Buffer): Promise<void> {
  await ensureBucket();
  await s3().send(new PutObjectCommand({
    Bucket: PLUGIN_ARTIFACT_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'application/zip',
  }));
}

/**
 * Download a build-context ZIP to a local file. Streams straight to disk (build
 * contexts can be large) rather than buffering. Throws if the key is absent —
 * the worker treats a missing context as a hard build failure.
 */
export async function getPluginArtifactToFile(key: string, destPath: string): Promise<void> {
  const out = await s3().send(new GetObjectCommand({ Bucket: PLUGIN_ARTIFACT_BUCKET, Key: key }));
  // In Node the SDK returns a Readable; narrow the union and stream to disk.
  await pipeline(out.Body as Readable, createWriteStream(destPath));
}

/** Best-effort single-object delete — never throws (blob cleanup is housekeeping;
 *  the bucket's expiry lifecycle rule is the guaranteed backstop). */
export async function deletePluginArtifact(key: string | undefined): Promise<void> {
  if (!key) return;
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: PLUGIN_ARTIFACT_BUCKET, Key: key }));
  } catch (err) {
    logger.warn('Plugin artifact delete failed (lifecycle rule will expire it)', { key, error: String(err) });
  }
}
