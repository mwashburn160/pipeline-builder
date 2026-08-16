// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * S3-compatible blob storage for message attachments.
 *
 * Backed by MinIO in every environment (self-hosted, no AWS-account coupling);
 * because MinIO speaks the S3 API, this uses the AWS S3 SDK so a real-S3 swap is
 * a pure config change (drop the custom endpoint + path-style, supply IAM creds).
 *
 * Config (env):
 *   S3_ENDPOINT           MinIO/S3 endpoint URL (e.g. http://minio:9000). Empty
 *                         ⇒ default AWS S3 (no custom endpoint).
 *   S3_REGION             region (default 'us-east-1').
 *   S3_ACCESS_KEY_ID      access key.
 *   S3_SECRET_ACCESS_KEY  secret key.
 *   S3_BUCKET             bucket name (default 'message-attachments').
 *   S3_FORCE_PATH_STYLE   'true' for MinIO (path-style addressing); default true.
 */

import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { createLogger, envStr, envBool, envInt } from '@pipeline-builder/api-core';
import { Jimp } from 'jimp';

const logger = createLogger('attachment-storage');

/** Resolved bucket name — the single bucket all attachment blobs live in. */
export const ATTACHMENT_BUCKET = envStr('S3_BUCKET', 'message-attachments');

/** Max long-edge (px) of a generated thumbnail. Env-overridable. */
export const THUMB_MAX_DIM = Math.max(48, envInt('MESSAGE_THUMBNAIL_MAX_DIM', 320));

/** Deterministic thumbnail key — a sibling of the original blob. */
export function thumbnailKeyFor(orgId: string, attachmentId: string): string {
  return `${orgId.toLowerCase()}/${attachmentId}/thumb`;
}

/** The thumbnail sibling of a full storage key (`…/<file>` → `…/thumb`). */
function thumbnailSiblingOf(storageKey: string): string {
  const i = storageKey.lastIndexOf('/');
  return i >= 0 ? `${storageKey.slice(0, i)}/thumb` : `${storageKey}.thumb`;
}

/** Content-type a thumbnail is stored/served as (PNG preserves alpha, else JPEG). */
export function thumbnailContentType(originalContentType: string): string {
  return originalContentType === 'image/png' ? 'image/png' : 'image/jpeg';
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
 * Ensure the attachments bucket exists (memoized). MinIO — unlike an
 * auto-provisioned S3 bucket — won't create it on first write, so we HEAD it and
 * CREATE on 404/NoSuchBucket. Idempotent + concurrency-safe (single in-flight
 * promise); a benign "already exists" race is swallowed.
 */
async function ensureBucket(): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      try {
        await s3().send(new HeadBucketCommand({ Bucket: ATTACHMENT_BUCKET }));
      } catch {
        try {
          await s3().send(new CreateBucketCommand({ Bucket: ATTACHMENT_BUCKET }));
          logger.info('Created attachments bucket', { bucket: ATTACHMENT_BUCKET });
        } catch (err) {
          // Another replica may have created it between our HEAD and CREATE.
          logger.warn('Attachments bucket ensure race (continuing)', { error: String(err) });
        }
      }
    })();
  }
  return bucketReady;
}

/** Store a blob. Key convention: `<orgId>/<attachmentId>/<filename>`. */
export async function putAttachment(key: string, body: Buffer, contentType: string): Promise<void> {
  await ensureBucket();
  await s3().send(new PutObjectCommand({
    Bucket: ATTACHMENT_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

/** Fetch a blob as a Node stream (for piping to the HTTP response). */
export async function getAttachmentStream(key: string): Promise<Readable> {
  const out = await s3().send(new GetObjectCommand({ Bucket: ATTACHMENT_BUCKET, Key: key }));
  // In Node the SDK returns a Readable; narrow the union.
  return out.Body as Readable;
}

/** Like {@link getAttachmentStream} but returns null instead of throwing when
 *  the key is absent (or any fetch error) — used for the thumbnail path, which
 *  falls back to the original blob when no thumbnail exists. */
export async function getAttachmentStreamOrNull(key: string): Promise<Readable | null> {
  try {
    return await getAttachmentStream(key);
  } catch {
    return null;
  }
}

/**
 * Generate a downscaled thumbnail (≤ {@link THUMB_MAX_DIM} on the long edge) from
 * an image buffer using PURE-JS jimp (no native deps — the alpine service image
 * needs no libvips). Returns null when:
 *  - the image is already within the thumbnail box (no point upscaling), or
 *  - it can't be decoded (e.g. webp — the default jimp codecs don't cover it),
 * so the caller just serves the original. NEVER throws — thumbnailing is
 * best-effort and must never fail an upload.
 */
export async function generateThumbnail(buffer: Buffer, contentType: string): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const img = await Jimp.read(buffer);
    if (img.width <= THUMB_MAX_DIM && img.height <= THUMB_MAX_DIM) return null;
    img.scaleToFit({ w: THUMB_MAX_DIM, h: THUMB_MAX_DIM });
    const outType = thumbnailContentType(contentType);
    const body = await img.getBuffer(outType as 'image/jpeg' | 'image/png');
    return { body: Buffer.from(body), contentType: outType };
  } catch (err) {
    logger.warn('Thumbnail generation failed (will serve original)', { error: String(err) });
    return null;
  }
}

/** Best-effort single-object delete — never throws (blob cleanup is housekeeping). */
export async function deleteAttachment(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: ATTACHMENT_BUCKET, Key: key }));
  } catch (err) {
    logger.warn('Attachment blob delete failed (leaving orphan)', { key, error: String(err) });
  }
}

/** Best-effort bulk delete for cascade cleanup — never throws. Each key's
 *  thumbnail sibling is deleted alongside it (deleting an absent thumb key is a
 *  no-op in S3/MinIO), so image thumbnails never orphan on a purge. */
export async function deleteAttachments(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const withThumbs = keys.flatMap((k) => [k, thumbnailSiblingOf(k)]);
  try {
    await s3().send(new DeleteObjectsCommand({
      Bucket: ATTACHMENT_BUCKET,
      Delete: { Objects: withThumbs.map((Key) => ({ Key })), Quiet: true },
    }));
  } catch (err) {
    logger.warn('Attachment bulk blob delete failed (leaving orphans)', { count: keys.length, error: String(err) });
  }
}

/**
 * Delete EVERY blob under an org's key prefix (`<orgId>/…`) — the org-purge
 * cleanup the platform cascade can't do itself (it hard-deletes the
 * `message_attachments` metadata rows but holds no object-storage client, so the
 * blobs would orphan). Lists + bulk-deletes in pages of 1000 (the S3
 * ListObjectsV2 / DeleteObjects cap), returning the count removed.
 *
 * UNLIKE the best-effort single/bulk deletes, a page failure THROWS so the
 * caller (the internal purge route) can surface a non-2xx and the cascade can
 * treat blob cleanup as incomplete — a silent partial purge is how orphans
 * accumulate unnoticed. The orgId is lower-cased to match the write-side key.
 */
export async function deleteAttachmentsByOrgPrefix(orgId: string): Promise<number> {
  // Trailing slash so `org-1/` never matches `org-10/…` (prefix over-match).
  const prefix = `${orgId.toLowerCase()}/`;
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await s3().send(new ListObjectsV2Command({
      Bucket: ATTACHMENT_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string');
    if (objects.length > 0) {
      await s3().send(new DeleteObjectsCommand({
        Bucket: ATTACHMENT_BUCKET,
        Delete: { Objects: objects.map((Key) => ({ Key })), Quiet: true },
      }));
      deleted += objects.length;
    }
    // IsTruncated ⇒ more pages; carry the token forward.
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  logger.info('Purged attachment blobs by org prefix', { orgId: prefix, deleted });
  return deleted;
}
