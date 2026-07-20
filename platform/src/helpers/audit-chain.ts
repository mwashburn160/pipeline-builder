// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { createLogger } from '@pipeline-builder/api-core';
import AuditEvent, { type AuditEventDocument } from '../models/audit-event.js';
import type { AuditCreateInput } from '../services/audit-service.js';

const logger = createLogger('audit-chain');

/**
 * TAMPER-EVIDENCE: per-tenant hash CHAIN over audit events.
 *
 * Design
 * ------
 * - Chain key: `affectedOrgId ?? orgId` — the NATURAL tenant chain. It answers
 *   "reconstruct everything that happened TO org X, in order, un-tampered",
 *   which is the SOC2/forensic question the audit log exists to answer. Both
 *   write paths (`helpers/audit.ts` and the `POST /audit/events` ingest, via
 *   `auditService.createEvent`) already default `affectedOrgId` to the actor's
 *   `orgId`, so for in-tenant actions the two coincide; cross-tenant sysadmin
 *   actions are (correctly) filed under the org they TOUCHED. `appendAuditEvent`
 *   re-applies that same defaulting so the STORED `affectedOrgId` always equals
 *   the chain key — which is why the existing `{ affectedOrgId: 1, createdAt: -1 }`
 *   index doubles as the chain (tail-lookup) index; no new index is required.
 * - Events with NO org context at all (anonymous actions, `bootstrap-env`
 *   super-admin grants) share the single {@link GENESIS_CHAIN_KEY} chain.
 * - Digest: `hash = sha256(canonical)` where `canonical` is a STABLE, sorted-key
 *   JSON serialization of the event's immutable fields (action, actorId, orgId,
 *   affectedOrgId, targetType, targetId, outcome, details, createdAt) PLUS the
 *   `prevHash`. Sorted keys + a normalization of every absent field to `null`
 *   make re-computation from the stored row reproducible regardless of key order
 *   or undefined-vs-missing quirks in what Mongo returns.
 * - `prevHash` = the `hash` of the most recent PRIOR event in the same chain, or
 *   `null` for the first (genesis) event.
 *
 * Single-writer-per-process
 * --------------------------
 * Appends are serialized PER CHAIN by an in-process async queue (see
 * {@link withChainLock}) so two concurrent appends can't read the same tail and
 * fork the chain. This is only correct for a SINGLE writer process. A
 * multi-replica deployment would need a stronger, cross-process lock (an atomic
 * compare-and-set on the tail, an advisory DB lock, or a leader) — OUT OF SCOPE
 * here. Tamper-evidence is a DETECTION aid, not a write gate: a hashing/chain
 * error must never drop the event or fail the originating request, so the append
 * path is best-effort (see {@link appendAuditEvent}).
 */

/** Chain key for the org-less / genesis chain (no `affectedOrgId` and no `orgId`). */
export const GENESIS_CHAIN_KEY = '__no-org__';

/** `prevHash` value for the first event in any chain. */
export const GENESIS_PREV_HASH: null = null;

/** Stored `hash` sentinel when digest computation itself failed — the row is
 *  still written (best-effort) but is visibly flagged as un-verifiable. */
export const HASH_ERROR_SENTINEL = 'HASH_ERROR';

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

/** The immutable fields the hash is computed over (stored fields only). */
export interface AuditHashFields {
  action: string;
  actorId: string;
  orgId?: string | null;
  affectedOrgId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: string | null;
  details?: Record<string, unknown> | null;
  createdAt: Date;
  prevHash: string | null;
}

/**
 * Compute the SHA-256 digest of an audit event's immutable fields + `prevHash`.
 * Used by BOTH the append path (fresh events) and {@link verifyAuditChain}
 * (recomputation from stored rows) so a hash reproduces exactly.
 */
export function computeAuditHash(f: AuditHashFields): string {
  const createdAt = f.createdAt instanceof Date ? f.createdAt : new Date(f.createdAt);
  const canonical = stableStringify({
    action: f.action,
    actorId: f.actorId,
    orgId: f.orgId ?? null,
    affectedOrgId: f.affectedOrgId ?? null,
    targetType: f.targetType ?? null,
    targetId: f.targetId ?? null,
    outcome: f.outcome ?? null,
    details: f.details ?? null,
    createdAt: createdAt.toISOString(),
    prevHash: f.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Resolve the chain key for an event from its org context. */
export function chainKeyForEvent(e: { affectedOrgId?: string | null; orgId?: string | null }): string {
  return e.affectedOrgId ?? e.orgId ?? GENESIS_CHAIN_KEY;
}

/**
 * Mongo filter selecting exactly one chain. Because the stored `affectedOrgId`
 * always equals the chain key (append re-applies the `?? orgId` defaulting), the
 * chain is `{ affectedOrgId }`; the genesis chain is the rows with no
 * `affectedOrgId` (`{ affectedOrgId: null }` also matches a missing field).
 */
function chainFilter(chainKey: string): Record<string, unknown> {
  return chainKey === GENESIS_CHAIN_KEY ? { affectedOrgId: null } : { affectedOrgId: chainKey };
}

// ---------------------------------------------------------------------------
// Per-chain serialization (single-writer-per-process; see the header comment).
// ---------------------------------------------------------------------------
const chainTails = new Map<string, Promise<void>>();

/**
 * Serialize `fn` against all other appends for the same `key`: each append waits
 * for the previous one on its chain to finish (regardless of that one's outcome)
 * before reading the tail, so concurrent appends can't fork the chain. The map
 * entry is cleaned up once the chain drains to avoid unbounded growth.
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Append an audit event to its per-tenant hash chain and persist it. This is the
 * SINGLE shared "append to chain" function both write paths funnel through:
 *   - `helpers/audit.ts` `audit()` calls it directly, and
 *   - `auditService.createEvent()` delegates to it (so the `POST /audit/events`
 *     ingest, the `authz.denied` sink, and bootstrap super-admin grants are all
 *     chained too).
 *
 * Best-effort by contract: a tail-lookup or hashing failure is LOGGED and the
 * row is still written (with a genesis `prevHash` / sentinel hash) rather than
 * dropped — tamper-evidence must never become a write gate.
 */
export async function appendAuditEvent(input: AuditCreateInput): Promise<AuditEventDocument> {
  // Normalize so the STORED affectedOrgId equals the chain key (mirrors the
  // defaulting both callers already do; harmless when they've set it).
  const affectedOrgId = input.affectedOrgId ?? input.orgId;
  const chainKey = affectedOrgId ?? GENESIS_CHAIN_KEY;

  return withChainLock(chainKey, async () => {
    // Assign createdAt explicitly so the value hashed is exactly the value
    // stored. Mongoose's `timestamps` plugin preserves an explicitly-provided
    // createdAt on insert (it only auto-fills a missing one).
    const createdAt = new Date();

    let prevHash: string | null = GENESIS_PREV_HASH;
    try {
      const tail = await AuditEvent.findOne(chainFilter(chainKey))
        .sort({ createdAt: -1, _id: -1 })
        .select('hash')
        .lean();
      prevHash = (tail?.hash as string | undefined) ?? GENESIS_PREV_HASH;
    } catch (err) {
      // Best-effort: fall back to a genesis link rather than dropping the event.
      logger.warn('Audit chain tail lookup failed; writing with genesis prevHash', {
        chainKey, error: errMessage(err),
      });
      prevHash = GENESIS_PREV_HASH;
    }

    let hash: string;
    try {
      hash = computeAuditHash({ ...input, affectedOrgId, createdAt, prevHash });
    } catch (err) {
      logger.warn('Audit hash computation failed; writing sentinel hash', {
        chainKey, error: errMessage(err),
      });
      hash = HASH_ERROR_SENTINEL;
    }

    return AuditEvent.create({ ...input, affectedOrgId, createdAt, prevHash, hash });
  });
}

/** Result of a chain verification walk. */
export interface AuditChainVerifyResult {
  /** True when every event's hash recomputes and links to its predecessor. */
  ok: boolean;
  /** `_id` of the first event that failed (broken hash or broken linkage). */
  brokenAt?: string;
  /** How many events were walked. */
  count: number;
}

/**
 * Walk a chain in creation order and verify tamper-evidence: for every event,
 * recompute its hash from the stored fields and check that (a) it matches the
 * stored `hash` and (b) its `prevHash` equals the previous event's `hash`. A
 * mismatch at either check means a row was ALTERED or DELETED after the fact.
 *
 * @param chainKey the tenant chain to verify (an org id, or {@link GENESIS_CHAIN_KEY}).
 */
export async function verifyAuditChain(chainKey: string): Promise<AuditChainVerifyResult> {
  const events = await AuditEvent.find(chainFilter(chainKey))
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  let expectedPrev: string | null = GENESIS_PREV_HASH;
  for (const raw of events as unknown as Array<Record<string, unknown>>) {
    const storedPrev = (raw.prevHash ?? null) as string | null;
    // Broken linkage: a deleted predecessor or a re-pointed prevHash.
    if (storedPrev !== expectedPrev) {
      return { ok: false, brokenAt: String(raw._id), count: events.length };
    }
    const recomputed = computeAuditHash({
      action: raw.action as string,
      actorId: raw.actorId as string,
      orgId: raw.orgId as string | undefined,
      affectedOrgId: raw.affectedOrgId as string | undefined,
      targetType: raw.targetType as string | undefined,
      targetId: raw.targetId as string | undefined,
      outcome: raw.outcome as string | undefined,
      details: raw.details as Record<string, unknown> | undefined,
      createdAt: raw.createdAt as Date,
      prevHash: storedPrev,
    });
    // Broken content: a field was mutated after the hash was written.
    if (recomputed !== raw.hash) {
      return { ok: false, brokenAt: String(raw._id), count: events.length };
    }
    expectedPrev = raw.hash as string;
  }
  return { ok: true, count: events.length };
}
