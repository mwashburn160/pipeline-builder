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
 * The client itself and the create-bucket-once backstop are api-core's shared
 * `s3-client` (`@pipeline-builder/api-core/s3`) — the same ones the message
 * service's attachment storage uses, so the connection config and the
 * benign-race-vs-real-outage handling cannot drift between the two. This module
 * keeps only what is plugin's own: the buckets and the key conventions.
 *
 * Config (env): `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` /
 * `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` are read by the shared client;
 * `S3_BUCKET` (default 'plugins') and `PLUGIN_QUARANTINE_BUCKET` are read here.
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createLogger, envStr } from '@pipeline-builder/api-core';
import { ensureBucket, s3Client } from '@pipeline-builder/api-core/s3';

const logger = createLogger('plugin-artifact-storage');

/** Resolved bucket name — the single bucket all plugin build contexts live in. */
export const PLUGIN_ARTIFACT_BUCKET = envStr('S3_BUCKET', 'plugins');

/**
 * The SEPARATE bucket anonymous submissions are staged in (plugin-ecosystem
 * ): `submissions/<id>.zip`, 30-day lifecycle expiry. Same client and
 * credentials as the build-context bucket; never read by the tenant build path.
 */
export function pluginQuarantineBucket(): string {
  return envStr('PLUGIN_QUARANTINE_BUCKET', 'plugin-quarantine');
}

/** The quarantine key of a submission's zip. */
export function submissionArtifactKey(submissionId: string): string {
  return `submissions/${submissionId}.zip`;
}

/**
 * Deterministic key for a build-context blob: `<orgId>/<requestId>.zip`. The
 * requestId is unique per upload, so a key never collides across builds.
 */
export function pluginArtifactKey(orgId: string, requestId: string): string {
  return `${orgId.toLowerCase()}/${requestId}.zip`;
}

/** Upload a build-context ZIP. Throws on failure — the caller must not enqueue a
 *  build whose context never reached durable storage (a cross-pod build would
 *  then fail to materialize it). */
export async function putPluginArtifact(key: string, body: Buffer, bucket: string = PLUGIN_ARTIFACT_BUCKET): Promise<void> {
  await ensureBucket(bucket);
  await s3Client().send(new PutObjectCommand({
    Bucket: bucket,
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
export async function getPluginArtifactToFile(key: string, destPath: string, bucket: string = PLUGIN_ARTIFACT_BUCKET): Promise<void> {
  const out = await s3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  // In Node the SDK returns a Readable; narrow the union and stream to disk.
  await pipeline(out.Body as Readable, createWriteStream(destPath));
}

/** Best-effort single-object delete — never throws (blob cleanup is housekeeping;
 *  the bucket's expiry lifecycle rule is the guaranteed backstop). */
export async function deletePluginArtifact(key: string | undefined, bucket: string = PLUGIN_ARTIFACT_BUCKET): Promise<void> {
  if (!key) return;
  try {
    await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    logger.warn('Plugin artifact delete failed (lifecycle rule will expire it)', { key, error: String(err) });
  }
}
