// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomUUID } from 'crypto';
import { createLogger, scrubAwsIdentifiers, errorMessage } from '@pipeline-builder/api-core';
import { requireAuditChainHmacKey } from '../config/audit-chain-key.js';
import AuditChainHead from '../models/audit-chain-head.js';
import AuditEvent, { type AuditEventDocument } from '../models/audit-event.js';
import type { AuditCreateInput } from '../services/audit-service.js';

const logger = createLogger('audit-chain');

/**
 * TAMPER-EVIDENCE: per-tenant HMAC hash CHAIN over audit events.
 *
 * Design
 * ------
 * - Chain key: `affectedOrgId ?? orgId` — the NATURAL tenant chain. It answers
 *   "reconstruct everything that happened TO org X, in order, un-tampered".
 *   `appendAuditEvent` re-applies the `?? orgId` defaulting so the STORED
 *   `affectedOrgId` always equals the chain key. Events with NO org context
 *   share the single {@link GENESIS_CHAIN_KEY} chain.
 * - ORDER is a per-chain SEQUENCE, not wall-clock time. The chain head
 *   (`audit_chain_heads`, no TTL) holds `{ seq, hash }`; an append takes
 *   `seq = head.seq + 1`, `prevHash = head.hash`, and inserts under the UNIQUE
 *   `(affectedOrgId, seq)` index. That index is the cross-replica
 *   compare-and-set: a writer that loses the slot re-reads the head and
 *   retries, so the chain never forks and never depends on replica clocks.
 *   (A blind `$inc` counter was rejected: a writer that dies between
 *   allocating a number and inserting leaves a permanent gap that verify must
 *   read as a deleted row. The insert-then-advance CAS is gapless.)
 * - Digest: `hash = HMAC-SHA256(AUDIT_CHAIN_HMAC_KEY, canonical)` where
 *   `canonical` is a stable, sorted-key JSON of every immutable, write-once
 *   field PLUS `seq` and `prevHash`. The key lives outside the DB (env / KMS
 *   secret), so someone who can write Mongo but doesn't hold the key cannot
 *   produce a consistent chain after editing, deleting or inserting a row.
 * - Tail truncation (deleting the NEWEST rows and rewinding the head) is the
 *   one edit a hash chain can't see from the inside. The chain-head exporter
 *   (`services/audit-head-export.ts`) periodically publishes each head, signed
 *   with the same key, to WRITE-ONCE object storage; {@link verifyAuditChain}
 *   checks the chain still reaches that published head.
 *
 * Best-effort by contract: tamper-evidence is a DETECTION aid, not a write
 * gate. A digest failure writes a sentinel hash instead of dropping the event,
 * and a failed platform-local write is spooled for retry (`helpers/audit.ts`).
 */

/** Chain key for the org-less / genesis chain (no `affectedOrgId` and no `orgId`). */
export const GENESIS_CHAIN_KEY = '__no-org__';

/** `prevHash` value for the first event in any chain. */
export const GENESIS_PREV_HASH: null = null;

/**
 * Stored `hash` prefix when digest computation itself failed — the row is still
 * written (best-effort) but is visibly flagged as un-verifiable.
 *
 * Only a PREFIX: each sentinel row gets a unique suffix from
 * {@link hashErrorSentinel}, so two digest failures in one chain never share a
 * `hash` (a successor's `prevHash` then names exactly one predecessor).
 */
export const HASH_ERROR_SENTINEL = 'HASH_ERROR';

/** A unique, recognizable un-verifiable-hash marker. See {@link HASH_ERROR_SENTINEL}. */
export function hashErrorSentinel(): string {
  return `${HASH_ERROR_SENTINEL}:${randomUUID()}`;
}

/** Whether a stored `hash` is an un-verifiable-hash marker rather than a digest. */
function isHashErrorSentinel(hash: unknown): boolean {
  return typeof hash === 'string' && (hash === HASH_ERROR_SENTINEL || hash.startsWith(`${HASH_ERROR_SENTINEL}:`));
}

/**
 * Deterministic JSON serialization with recursively sorted object keys.
 * - `undefined` / `null` → `null` (so absent fields hash identically).
 * - `Date` → its ISO string (Mongo round-trips these as `Date`).
 * - object keys are sorted; `undefined`-valued keys are dropped (JSON semantics).
 * This is what makes a stored row's hash reproducible on the verify path.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * The immutable, write-once fields the hash is computed over (stored fields
 * only). Every field here is set at event creation and never updated
 * (`timestamps.updatedAt` is off), so hashing them makes a post-hoc mutation of
 * ANY of them detectable — notably `impersonatorId` (who really acted, under a
 * "view-as" token) and `roleId` (which Role was touched), the high-value
 * forensic-attribution fields an attacker would want to rewrite. `seq` binds
 * each row to its chain position, so rows can't be re-ordered or renumbered.
 */
export interface AuditHashFields {
  action: string;
  actorId: string;
  actorEmail?: string | null;
  actorRole?: string | null;
  orgId?: string | null;
  affectedOrgId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  roleId?: string | null;
  impersonatorId?: string | null;
  outcome?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  createdAt: Date;
  seq: number;
  prevHash: string | null;
}

let cachedKey: string | null = null;

/** The chain HMAC key (env / KMS secret, never the DB). Resolved on first use. */
function chainKeyMaterial(): string {
  if (cachedKey === null) cachedKey = requireAuditChainHmacKey();
  return cachedKey;
}

/** HMAC-SHA256 with the chain key over a domain-separated message. */
export function auditHmac(domain: 'event' | 'head', message: string): string {
  return createHmac('sha256', chainKeyMaterial()).update(`pb-audit-${domain}-v1\n`).update(message).digest('hex');
}

/**
 * Compute the HMAC digest of an audit event's immutable fields + `seq` +
 * `prevHash`. Used by BOTH the append path (fresh events) and
 * {@link verifyAuditChain} (recomputation from stored rows).
 */
export function computeAuditHash(f: AuditHashFields): string {
  const createdAt = f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt);
  const canonical = stableStringify({
    action: f.action,
    actorId: f.actorId,
    actorEmail: f.actorEmail ?? null,
    actorRole: f.actorRole ?? null,
    orgId: f.orgId ?? null,
    affectedOrgId: f.affectedOrgId ?? null,
    targetType: f.targetType ?? null,
    targetId: f.targetId ?? null,
    roleId: f.roleId ?? null,
    impersonatorId: f.impersonatorId ?? null,
    outcome: f.outcome ?? null,
    details: f.details ?? null,
    ip: f.ip ?? null,
    userAgent: f.userAgent ?? null,
    requestId: f.requestId ?? null,
    traceId: f.traceId ?? null,
    createdAt: createdAt.toISOString(),
    seq: f.seq,
    prevHash: f.prevHash,
  });
  return auditHmac('event', canonical);
}

/** Stable serialization shared with the head exporter's signature. */
export { stableStringify };

/**
 * Mongo filter selecting exactly one chain. Because the stored `affectedOrgId`
 * always equals the chain key (append re-applies the `?? orgId` defaulting), the
 * chain is `{ affectedOrgId }`; the genesis chain is the rows with no
 * `affectedOrgId` (`{ affectedOrgId: null }` also matches a missing field).
 */
export function chainFilter(chainKey: string): Record<string, unknown> {
  return chainKey === GENESIS_CHAIN_KEY ? { affectedOrgId: null } : { affectedOrgId: chainKey };
}

// ---------------------------------------------------------------------------
// Per-chain serialization (single-writer-per-process; see the header comment).
// ---------------------------------------------------------------------------
const chainTails = new Map<string, Promise<void>>();

/**
 * Serialize `fn` against all other appends for the same `key` within this
 * process, so local appends don't burn CAS retries against each other. Cross-
 * replica safety comes from the unique `(affectedOrgId, seq)` index, not this.
 */
function withChainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = chainTails.get(key) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  const settled = result.then(() => undefined, () => undefined);
  chainTails.set(key, settled);
  void settled.finally(() => {
    if (chainTails.get(key) === settled) chainTails.delete(key);
  });
  return result;
}

interface DupKeyError { code?: number; keyPattern?: Record<string, unknown>; message?: string }

function isDupOn(err: unknown, field: string): boolean {
  const e = err as DupKeyError | null;
  if (!e || e.code !== 11000) return false;
  if (e.keyPattern) return Object.prototype.hasOwnProperty.call(e.keyPattern, field);
  return typeof e.message === 'string' && e.message.includes(field);
}

/** E11000 on the per-org `(orgId, idempotencyKey)` index: this exact emission
 *  was already stored. Any OTHER duplicate-key violation propagates. */
function isIdempotencyDuplicate(err: unknown): boolean {
  return isDupOn(err, 'idempotencyKey');
}

/** E11000 on the `(affectedOrgId, seq)` index: another writer took this slot. */
function isSeqDuplicate(err: unknown): boolean {
  return isDupOn(err, 'seq');
}

/** Max CAS retries when another writer wins a chain slot. */
const MAX_CHAIN_RETRIES = 8;

interface ChainTail { seq: number; hash: string | null }

/** The chain's current head, from the head doc. Genesis when none exists. */
async function readHead(chainKey: string): Promise<ChainTail> {
  const head = await AuditChainHead.findById(chainKey).select('seq hash').lean();
  return head ? { seq: head.seq, hash: head.hash } : { seq: 0, hash: GENESIS_PREV_HASH };
}

/**
 * Move the head forward to `(seq, hash)` — never backward. The filter only
 * matches a head BEHIND `seq`; when the doc is already at/after it, the upsert's
 * insert collides on `_id` (E11000), which is exactly "someone got further" and
 * is ignored.
 */
async function advanceHead(chainKey: string, seq: number, hash: string, headCreatedAt: Date): Promise<void> {
  try {
    await AuditChainHead.updateOne(
      { _id: chainKey, seq: { $lt: seq } },
      { $set: { seq, hash, headCreatedAt } },
      { upsert: true },
    );
  } catch (err) {
    if ((err as DupKeyError)?.code === 11000) return;
    throw err;
  }
}

/**
 * Re-sync a head that LAGS the events (a writer died between its insert and
 * its head advance, or a head write failed): advance it to the highest `seq`
 * actually stored.
 */
async function repairHead(chainKey: string): Promise<void> {
  const top = await AuditEvent.findOne(chainFilter(chainKey))
    .sort({ seq: -1 })
    .select('seq hash createdAt')
    .lean();
  if (top && typeof top.seq === 'number' && typeof top.hash === 'string') {
    await advanceHead(chainKey, top.seq, top.hash, top.createdAt as Date);
  }
}

/**
 * Append an audit event to its per-tenant chain and persist it. The SINGLE
 * shared "append to chain" function every write path funnels through
 * (`helpers/audit.ts` `audit()`, and `auditService.createEvent()` — the
 * `POST /audit/events` ingest, the `authz.denied` sink, bootstrap grants).
 *
 * A digest failure is logged and the row still written (sentinel hash). A
 * persistence failure REJECTS — callers decide what durability they need
 * (`audit()` spools; the ingest returns 5xx so the remote client spools).
 */
export async function appendAuditEvent(input: AuditCreateInput): Promise<AuditEventDocument> {
  const affectedOrgId = input.affectedOrgId ?? input.orgId;
  const chainKey = affectedOrgId ?? GENESIS_CHAIN_KEY;

  // Defense-in-depth: scrub AWS account identifiers (bare 12-digit ids and the
  // account segment of any ARN) out of `details` at this single choke point,
  // BEFORE the hash is computed, so verify stays deterministic. An AWS account
  // id must never be persisted.
  const scrubbedInput: AuditCreateInput = input.details
    ? { ...input, details: scrubAwsIdentifiers(input.details) }
    : input;

  return withChainLock(chainKey, async () => {
    for (let attempt = 0; ; attempt++) {
      const tail = await readHead(chainKey);
      const seq = tail.seq + 1;
      const prevHash = tail.hash;
      // Stored verbatim and hashed; display/range-filter only — NOT the order.
      const createdAt = new Date();

      let hash: string;
      try {
        hash = computeAuditHash({ ...scrubbedInput, affectedOrgId, createdAt, seq, prevHash });
      } catch (err) {
        logger.warn('Audit hash computation failed; writing sentinel hash', {
          chainKey, error: errorMessage(err),
        });
        hash = hashErrorSentinel();
      }

      let row: AuditEventDocument;
      try {
        row = await AuditEvent.create({ ...scrubbedInput, affectedOrgId, createdAt, seq, prevHash, hash });
      } catch (err) {
        // Idempotency-Key collision (per org): this exact event was already
        // stored (a retried delivery, possibly from another replica). Return
        // the existing row WITHOUT extending the chain a second time.
        if (scrubbedInput.idempotencyKey && isIdempotencyDuplicate(err)) {
          const existing = await AuditEvent.findOne({
            orgId: scrubbedInput.orgId ?? null,
            idempotencyKey: scrubbedInput.idempotencyKey,
          }).lean();
          if (existing) {
            logger.info('Audit ingest deduped on Idempotency-Key; not re-chaining', {
              chainKey, idempotencyKey: scrubbedInput.idempotencyKey,
            });
            return existing as unknown as AuditEventDocument;
          }
        }
        // Chain-slot collision: another writer took `seq`. Bring the head up to
        // the stored tail (it may lag if that writer hasn't advanced it yet, or
        // died before doing so) and retry against it.
        if (isSeqDuplicate(err) && attempt < MAX_CHAIN_RETRIES) {
          logger.debug('Audit chain slot taken; re-reading the advanced head', { chainKey, seq, attempt });
          await repairHead(chainKey);
          continue;
        }
        throw err;
      }

      // Publish the new head. A failure here is recoverable (the next append's
      // slot collision repairs it), so it is logged, not thrown — the event IS
      // stored.
      try {
        await advanceHead(chainKey, seq, hash, createdAt);
      } catch (err) {
        logger.warn('Audit chain head advance failed (next append repairs it)', {
          chainKey, seq, error: errorMessage(err),
        });
      }
      return row;
    }
  });
}

/** Cursor batch size for {@link verifyAuditChain}'s streamed walk. */
const VERIFY_BATCH_SIZE = 500;

/** Why a verification failed. */
export type AuditChainBreak =
  | 'hash-mismatch'
  | 'broken-link'
  | 'sequence-gap'
  | 'head-mismatch'
  | 'tail-truncated'
  | 'published-head-invalid';

/** State of the chain's published (write-once) head, when an export target is configured. */
export interface PublishedHeadCheck {
  status: 'matched' | 'absent' | 'expired' | 'pruned' | 'unavailable';
  seq?: number;
  exportedAt?: string;
  /** True when the published head is older than 3 export intervals — the
   *  newest events aren't covered by an external anchor yet. */
  stale?: boolean;
}

/** Result of a chain verification walk. */
export interface AuditChainVerifyResult {
  /** True when every surviving event's hash recomputes, every non-first event
   *  links to its predecessor with the next sequence number, and the chain
   *  still reaches its in-DB head and its published head. Deletion of a
   *  contiguous run of the OLDEST rows is indistinguishable from TTL pruning and
   *  is therefore NOT flagged. */
  ok: boolean;
  /** `_id` of the first event that failed (hash / link / sequence). */
  brokenAt?: string;
  /** Machine-readable failure reason. */
  reason?: AuditChainBreak;
  /** Events walked — for an intact chain, its surviving length; on a row-level
   *  break, the position of the offending row (inclusive). */
  count: number;
  /** Rows whose stored `hash` is a {@link HASH_ERROR_SENTINEL} marker (digest
   *  could not be computed at write time): un-verifiable, not tampering. */
  unverifiable: number;
  /** Highest `seq` walked (0 for an empty chain). */
  lastSeq: number;
  /** Published-head comparison (omitted when no export target is configured). */
  publishedHead?: PublishedHeadCheck;
}

/** A published chain head, already signature-verified by the caller's fetcher. */
export interface PublishedHead {
  seq: number;
  hash: string;
  headCreatedAt: string;
  exportedAt: string;
}

export interface VerifyOptions {
  /** Fetch the chain's published head from write-once storage. Returns null
   *  when none has been published; throws `PublishedHeadInvalidError` when
   *  the object exists but its signature doesn't verify. Omit when no export
   *  target is configured. */
  fetchPublishedHead?: (chainKey: string) => Promise<PublishedHead | null>;
  /** Audit TTL in ms — a head older than this may have legitimately aged out. */
  retentionMs: number;
  /** Export interval in ms (for the staleness hint). */
  exportIntervalMs?: number;
  now?: Date;
}

/** Thrown by a published-head fetcher when the stored object fails its signature. */
export class PublishedHeadInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PublishedHeadInvalidError';
  }
}

/**
 * Walk a chain in SEQUENCE order and verify tamper-evidence.
 *
 * Row level: the first surviving event is the anchor (its predecessors may
 * have aged out under the TTL). Every later event must carry `seq = prev + 1`
 * and `prevHash = prev.hash`, and every event's HMAC must recompute. This
 * catches field tampering, reordering/renumbering, and deleting any row that
 * has a surviving successor.
 *
 * Tail level: the walk must reach (a) the in-DB head doc and (b) the published
 * write-once head — unless that head event is older than the retention window
 * (it may have aged out). Reaching means the event at that `seq` still exists
 * with the SAME hash; a published head beyond the last surviving row is TAIL
 * TRUNCATION, the one edit an internal chain can't reveal.
 *
 * @param chainKey the tenant chain to verify (an org id, or {@link GENESIS_CHAIN_KEY}).
 */
export async function verifyAuditChain(chainKey: string, opts: VerifyOptions = { retentionMs: Infinity }): Promise<AuditChainVerifyResult> {
  const now = opts.now ?? new Date();
  let published: PublishedHead | null = null;
  let publishedCheck: PublishedHeadCheck | undefined;
  if (opts.fetchPublishedHead) {
    try {
      published = await opts.fetchPublishedHead(chainKey);
      publishedCheck = published
        ? { status: 'matched', seq: published.seq, exportedAt: published.exportedAt }
        : { status: 'absent' };
    } catch (err) {
      if (err instanceof PublishedHeadInvalidError) {
        return { ok: false, reason: 'published-head-invalid', count: 0, unverifiable: 0, lastSeq: 0, publishedHead: { status: 'unavailable' } };
      }
      logger.warn('Published audit head unavailable; verifying without the external anchor', {
        chainKey, error: errorMessage(err),
      });
      publishedCheck = { status: 'unavailable' };
    }
  }
  const dbHead = await AuditChainHead.findById(chainKey).select('seq hash headCreatedAt').lean();

  // Heads to reach: seq → expected hash, only while the head event is inside
  // the retention window (older ones may have been TTL-pruned legitimately).
  const withinRetention = (createdAt: Date | string): boolean =>
    now.getTime() - new Date(createdAt).getTime() < opts.retentionMs;
  const anchors: Array<{ seq: number; hash: string; source: 'db' | 'published' }> = [];
  if (dbHead && withinRetention(dbHead.headCreatedAt)) anchors.push({ seq: dbHead.seq, hash: dbHead.hash, source: 'db' });
  if (published) {
    if (withinRetention(published.headCreatedAt)) anchors.push({ seq: published.seq, hash: published.hash, source: 'published' });
    else publishedCheck = { ...publishedCheck!, status: 'expired' };
  }

  // STREAMED, not materialized: O(1) memory regardless of chain length.
  const cursor = AuditEvent.find(chainFilter(chainKey))
    .sort({ seq: 1 })
    .lean()
    .cursor({ batchSize: VERIFY_BATCH_SIZE });

  let expectedPrev: string | null = null;
  let prevSeq = 0;
  let firstSeq: number | null = null;
  let count = 0;
  let unverifiable = 0;
  const reachedHash = new Map<number, string>();
  const anchorSeqs = new Set(anchors.map((a) => a.seq));
  const fail = (raw: Record<string, unknown>, reason: AuditChainBreak): AuditChainVerifyResult =>
    ({ ok: false, brokenAt: String(raw._id), reason, count, unverifiable, lastSeq: prevSeq, ...(publishedCheck ? { publishedHead: publishedCheck } : {}) });
  try {
    for await (const leanDoc of cursor) {
      const raw = leanDoc as unknown as Record<string, unknown>;
      count += 1;
      const seq = raw.seq as number;
      const storedPrev = (raw.prevHash ?? null) as string | null;
      if (firstSeq === null) {
        // Anchor: accept the first survivor's own link (genesis or TTL-pruned head).
        firstSeq = seq;
      } else {
        if (seq !== prevSeq + 1) return fail(raw, 'sequence-gap');
        if (storedPrev !== expectedPrev) return fail(raw, 'broken-link');
      }
      if (isHashErrorSentinel(raw.hash)) {
        unverifiable += 1;
      } else {
        const recomputed = computeAuditHash({
          action: raw.action as string,
          actorId: raw.actorId as string,
          actorEmail: raw.actorEmail as string | undefined,
          actorRole: raw.actorRole as string | undefined,
          orgId: raw.orgId as string | undefined,
          affectedOrgId: raw.affectedOrgId as string | undefined,
          targetType: raw.targetType as string | undefined,
          targetId: raw.targetId as string | undefined,
          roleId: raw.roleId as string | undefined,
          impersonatorId: raw.impersonatorId as string | undefined,
          outcome: raw.outcome as string | undefined,
          details: raw.details as Record<string, unknown> | undefined,
          ip: raw.ip as string | undefined,
          userAgent: raw.userAgent as string | undefined,
          requestId: raw.requestId as string | undefined,
          traceId: raw.traceId as string | undefined,
          createdAt: raw.createdAt as Date,
          seq,
          prevHash: storedPrev,
        });
        if (recomputed !== raw.hash) return fail(raw, 'hash-mismatch');
      }
      if (anchorSeqs.has(seq)) reachedHash.set(seq, raw.hash as string);
      expectedPrev = raw.hash as string;
      prevSeq = seq;
    }
  } finally {
    await cursor.close();
  }

  for (const a of anchors) {
    if (firstSeq !== null && a.seq < firstSeq) {
      // The anchored event itself aged out ahead of its retention estimate
      // (e.g. a lowered AUDIT_RETENTION_DAYS); everything after it survives.
      if (a.source === 'published') publishedCheck = { ...publishedCheck!, status: 'pruned' };
      continue;
    }
    const got = reachedHash.get(a.seq);
    if (got === undefined) {
      return { ok: false, reason: 'tail-truncated', count, unverifiable, lastSeq: prevSeq, ...(publishedCheck ? { publishedHead: publishedCheck } : {}) };
    }
    if (got !== a.hash) {
      return { ok: false, reason: 'head-mismatch', count, unverifiable, lastSeq: prevSeq, ...(publishedCheck ? { publishedHead: publishedCheck } : {}) };
    }
  }

  if (publishedCheck?.status === 'matched' && published && opts.exportIntervalMs) {
    const age = now.getTime() - new Date(published.exportedAt).getTime();
    if (age > 3 * opts.exportIntervalMs && prevSeq > published.seq) publishedCheck = { ...publishedCheck, stale: true };
  }
  return { ok: true, count, unverifiable, lastSeq: prevSeq, ...(publishedCheck ? { publishedHead: publishedCheck } : {}) };
}
