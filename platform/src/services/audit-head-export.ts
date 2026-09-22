// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chain-head export: periodically publish each audit chain's head — signed
 * with the chain HMAC key — to WRITE-ONCE object storage, and read it back for
 * `/audit/verify`.
 *
 * Why: a hash chain proves every surviving row is untouched and contiguous,
 * but someone with DB write access can still delete the NEWEST rows and rewind
 * the in-DB head; what remains is a perfectly valid, shorter chain. An
 * external, immutable record of "chain X had reached seq N with hash H at time
 * T" is what exposes that truncation.
 *
 * Storage layout (bucket from `AUDIT_HEAD_EXPORT_S3_BUCKET`, created WITH
 * Object Lock — versioning is implied):
 *   <prefix>/<chainKey>/latest.json          overwritten each export (every
 *                                            version retained under the lock)
 *   <prefix>/<chainKey>/<seq, 12 digits>.json one immutable object per export
 * Every PUT carries `x-amz-object-lock-mode` + `retain-until-date` (unless
 * `AUDIT_HEAD_EXPORT_LOCK_MODE=none` for a target without Object Lock), so a
 * head can't be deleted or overwritten-in-place before retention lapses — not
 * even by the platform's own credentials under COMPLIANCE mode.
 *
 * The signature (`sig`) is `HMAC(AUDIT_CHAIN_HMAC_KEY, …)` over the payload,
 * domain-separated from event hashes, so a party holding only the bucket
 * credentials can't forge a head. Verify rejects a head whose signature fails.
 */

import { timingSafeEqual } from 'crypto';
import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import { auditHmac, PublishedHeadInvalidError, stableStringify, verifyAuditChain, type AuditChainVerifyResult, type PublishedHead } from '../helpers/audit-chain.js';
import AuditChainHead from '../models/audit-chain-head.js';
import { s3GetObject, s3PutObject, type S3Target } from '../utils/s3-sigv4.js';

const logger = createLogger('audit-head-export');

/** Wire format version of an exported head. */
const HEAD_FORMAT_VERSION = 1;

export interface ExportedHeadPayload extends PublishedHead {
  v: number;
  chainKey: string;
}

export interface ExportedHead extends ExportedHeadPayload {
  sig: string;
}

type HeadExportConfig = typeof config.audit.headExport;

/** The configured target, or null when the export is disabled (unset endpoint/creds). */
export function headExportTarget(cfg: HeadExportConfig = config.audit.headExport): S3Target | null {
  if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) return null;
  return {
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  };
}

/** Sign a head payload with the chain key (domain `head`). */
export function signHead(payload: ExportedHeadPayload): string {
  return auditHmac('head', stableStringify(payload));
}

function headKey(prefix: string, chainKey: string, name: string): string {
  // chainKey is an org id / fixed genesis key; encode anyway so no value can
  // walk out of its folder.
  return `${prefix}/${encodeURIComponent(chainKey)}/${name}`;
}

function lockHeaders(cfg: HeadExportConfig, now: Date): Record<string, string> {
  if (cfg.lockMode === 'none') return {};
  const until = new Date(now.getTime() + cfg.retentionDays * 86_400_000);
  return {
    'x-amz-object-lock-mode': cfg.lockMode,
    'x-amz-object-lock-retain-until-date': until.toISOString(),
  };
}

/** Outcome of one export pass. */
export interface HeadExportResult {
  exported: number;
  failed: number;
}

/**
 * Publish every chain head that advanced since its last export. Never throws;
 * a per-chain failure is logged and retried on the next pass (its
 * `exportedSeq` is only advanced after both objects are written).
 */
export async function exportAuditChainHeads(
  cfg: HeadExportConfig = config.audit.headExport,
  now: () => Date = () => new Date(),
): Promise<HeadExportResult> {
  const result: HeadExportResult = { exported: 0, failed: 0 };
  const target = headExportTarget(cfg);
  if (!target) return result;

  let heads: Array<{ _id: string; seq: number; hash: string; headCreatedAt: Date }>;
  try {
    heads = await AuditChainHead.find({ $expr: { $gt: ['$seq', { $ifNull: ['$exportedSeq', 0] }] } })
      .select('_id seq hash headCreatedAt')
      .lean();
  } catch (err) {
    logger.warn('Audit head export scan failed', { error: errorMessage(err) });
    return result;
  }

  for (const head of heads) {
    const at = now();
    const payload: ExportedHeadPayload = {
      v: HEAD_FORMAT_VERSION,
      chainKey: head._id,
      seq: head.seq,
      hash: head.hash,
      headCreatedAt: new Date(head.headCreatedAt).toISOString(),
      exportedAt: at.toISOString(),
    };
    const body = JSON.stringify({ ...payload, sig: signHead(payload) } satisfies ExportedHead);
    try {
      const headers = lockHeaders(cfg, at);
      await s3PutObject(target, headKey(cfg.prefix, head._id, `${String(head.seq).padStart(12, '0')}.json`), body, headers);
      await s3PutObject(target, headKey(cfg.prefix, head._id, 'latest.json'), body, headers);
      await AuditChainHead.updateOne(
        { _id: head._id, $or: [{ exportedSeq: { $lt: head.seq } }, { exportedSeq: { $exists: false } }] },
        { $set: { exportedSeq: head.seq } },
      );
      result.exported += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn('Audit head export failed for one chain (retried next pass)', {
        chainKey: head._id, seq: head.seq, error: errorMessage(err),
      });
    }
  }
  if (result.exported > 0 || result.failed > 0) logger.info('Audit head export pass', { ...result });
  return result;
}

function sigEquals(expected: string, got: string): boolean {
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(got, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Read + signature-verify a chain's latest published head. Returns null when
 * the export is disabled or nothing was published for this chain; throws
 * {@link PublishedHeadInvalidError} for a present-but-forged/corrupt head.
 */
export async function fetchPublishedHead(
  chainKey: string,
  cfg: HeadExportConfig = config.audit.headExport,
): Promise<PublishedHead | null> {
  const target = headExportTarget(cfg);
  if (!target) return null;
  const raw = await s3GetObject(target, headKey(cfg.prefix, chainKey, 'latest.json'));
  if (raw === null) return null;
  let parsed: ExportedHead;
  try {
    parsed = JSON.parse(raw) as ExportedHead;
  } catch {
    throw new PublishedHeadInvalidError('published head is not valid JSON');
  }
  const { sig, ...payload } = parsed;
  if (
    typeof sig !== 'string'
    || payload.v !== HEAD_FORMAT_VERSION
    || payload.chainKey !== chainKey
    || typeof payload.seq !== 'number'
    || typeof payload.hash !== 'string'
    || !sigEquals(signHead(payload), sig)
  ) {
    throw new PublishedHeadInvalidError('published head signature does not verify');
  }
  return { seq: payload.seq, hash: payload.hash, headCreatedAt: payload.headCreatedAt, exportedAt: payload.exportedAt };
}

/**
 * `/audit/verify`'s entry point: walk the chain with the configured retention
 * window and — when an export target is configured — against its published
 * write-once head.
 */
export async function verifyAuditChainAnchored(chainKey: string): Promise<AuditChainVerifyResult> {
  const cfg = config.audit.headExport;
  return verifyAuditChain(chainKey, {
    retentionMs: config.audit.retentionDays * 86_400_000,
    exportIntervalMs: cfg.intervalMs,
    ...(headExportTarget(cfg) ? { fetchPublishedHead: (key: string) => fetchPublishedHead(key, cfg) } : {}),
  });
}
