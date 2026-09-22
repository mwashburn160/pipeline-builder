// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.0 device authorization grant (RFC 8628) — the state machine behind
 * `pipeline-manager auth login`.
 *
 * WHY: the CLI used to take a password (or a long-lived refresh token) on the
 * command line, which put both into shell history, `ps` output and CI logs, and
 * bypassed everything the browser sign-in already enforces (SSO, step-up, and
 * later MFA). With the device grant the CLI never sees a credential at all: it
 * asks for a code, the person approves it in a NORMAL browser session, and the
 * CLI collects an ordinary interactive session on its next poll.
 *
 * The state lives in the shared Redis pending-state store (see
 * `helpers/pending-state-store.ts`), so the pod that mints a code, the pod that
 * serves the approval page and the pod that answers the poll need not be the
 * same one. Two entries per flow:
 *
 *   `devcode:<sha256(device_code)>` → the record below. Keyed by the HASH so a
 *      dump of Redis never yields a usable device code (same reasoning as the
 *      access-key limiter keying on a hash rather than the key).
 *   `devuser:<user_code>` → the record's key, the index the approval page uses.
 *
 * Brute-force resistance:
 *   - `device_code` is 256 bits of randomness — unguessable, and it is what the
 *     session is ultimately handed to.
 *   - `user_code` is short enough to read aloud, so it is the weak half: it is
 *     drawn from a 20-character alphabet with no vowels (no accidental words)
 *     and no look-alikes (no O/0, I/1, S/5, U/V confusion), giving 20^8 ≈ 2.6e10
 *     combinations, it lives at most {@link config.auth.device.ttlMs}, and the
 *     lookup route is rate-limited per signed-in user.
 *   - Every device code carries a hard poll ceiling, and a client polling faster
 *     than the advertised interval gets `slow_down` with a widened interval.
 *
 * Nothing here mints tokens: approval records WHO approved and with what
 * assurance, and the poll path hands that to the normal `issueTokens` helper so
 * a CLI session is an ordinary `interactive` refresh session, revocable from the
 * sessions-and-devices page like any other device.
 */

import crypto from 'crypto';
import type { AssuranceLevel, AuthMethod } from '@pipeline-builder/api-core';
import { config } from '../config/index.js';
import type { ClientInfo } from '../helpers/client-info.js';
import { createPendingStateStore } from '../helpers/pending-state-store.js';

/**
 * User-code alphabet: consonants only (no vowels ⇒ no accidental words), and no
 * character that reads like another in a terminal font. RFC 8628 §6.1 suggests
 * exactly this shape.
 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** Characters per user-code half; the code is rendered as `XXXX-XXXX`. */
const USER_CODE_HALF = 4;
const USER_CODE_LENGTH = USER_CODE_HALF * 2;

/** How many times a user-code collision is retried before giving up. */
const USER_CODE_ATTEMPTS = 5;

/** Slack on the poll-interval check, so ordinary clock jitter isn't `slow_down`. */
const INTERVAL_SLACK_MS = 250;

/** Seconds added to a client's interval each time it polls too fast (RFC 8628 §3.5). */
const SLOW_DOWN_STEP_SECONDS = 5;

/** How the approver authenticated, copied onto the CLI session verbatim. */
export interface DeviceApproval {
  userId: string;
  /** The org the approving browser session was scoped to (the CLI lands there). */
  orgId?: string;
  amr: AuthMethod[];
  aal: AssuranceLevel;
  /** Epoch ms — the ORIGINAL sign-in time, never reset by the approval. */
  authTime: number;
  /** Epoch ms the approver's step-up was verified (approval is step-up gated). */
  stepUpVerifiedAt: number;
  /** The approver's HARD `tokenVersion` at approval. Re-checked when the CLI
   *  session is issued: a sign-out-everywhere / password reset / deactivation
   *  in between voids the approval rather than minting a session through it. */
  tokenVersion: number;
  /** The approving browser session's slot — it must still exist at issue. */
  sessionId?: string;
}

/** One in-flight device authorization. */
export interface DeviceAuthRecord {
  /** Correlation handle for the audit trail: the first 12 hex of the device
   *  code's SHA-256. Non-secret (12 hex of a hash of 256 random bits) but stable
   *  across start → approve/deny → issue, so the four events join up. */
  id: string;
  userCode: string;
  /** The device that asked — shown on the approval page and stored on the session. */
  client: ClientInfo;
  createdAt: number;
  expiresAt: number;
  /** Current minimum poll interval in seconds; widened by `slow_down`. */
  interval: number;
  /** Epoch ms of the last poll (0 = never polled). */
  lastPolledAt: number;
  polls: number;
  status: 'pending' | 'approved' | 'denied';
  /** The CLI asked for a step-up token alongside the session (`auth pat`). */
  stepUpRequested: boolean;
  approval?: DeviceApproval;
}

/**
 * Both entries are kept a little past the flow's own `expiresAt`.
 *
 * WHY: a record that has simply vanished is indistinguishable from a code that
 * never existed, which would leave both the person ("that code was not
 * recognised" when it merely lapsed) and the audit trail ("no expire event,
 * ever") worse off. Keeping the entries briefly past the deadline lets both
 * sides say "expired" precisely — and costs nothing, because the deadline is
 * enforced against `record.expiresAt` on every path, so nothing inside the grace
 * window is redeemable.
 */
const EXPIRY_GRACE_MS = 5 * 60_000;

const deviceCodes = createPendingStateStore<DeviceAuthRecord>({
  prefix: 'devcode:',
  ttlMs: config.auth.device.ttlMs + EXPIRY_GRACE_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.auth.device.maxPending,
});

/** user_code → the `deviceCodes` key: the index the approval page looks up. */
/**
 * The DECISION for a flow, keyed like the record and written exactly once
 * (`putIfAbsent` — SET NX): the first approve/deny wins atomically, so two
 * racing decisions can't both succeed and a poll's counter rewrite of the record
 * can never erase one. The record carries only the flow's bookkeeping; its
 * status is read from here.
 */
interface DeviceDecision {
  status: 'approved' | 'denied';
  approval?: DeviceApproval;
}
const deviceDecisions = createPendingStateStore<DeviceDecision>({
  prefix: 'devdecision:',
  ttlMs: config.auth.device.ttlMs + EXPIRY_GRACE_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.auth.device.maxPending,
});

/** The record with its status/approval taken from the decision store. */
async function withDecision(key: string, record: DeviceAuthRecord): Promise<DeviceAuthRecord> {
  const decision = await deviceDecisions.peek(key);
  if (!decision) return { ...record, status: 'pending' };
  return { ...record, status: decision.status, ...(decision.approval ? { approval: decision.approval } : {}) };
}

const userCodeIndex = createPendingStateStore<string>({
  prefix: 'devuser:',
  ttlMs: config.auth.device.ttlMs + EXPIRY_GRACE_MS,
  cleanupIntervalMs: config.oauth.cleanupIntervalMs,
  maxEntries: config.auth.device.maxPending,
});

/** The store key for a raw device code — never the code itself. */
function codeKey(deviceCode: string): string {
  return crypto.createHash('sha256').update(deviceCode).digest('hex');
}

/** A user code in canonical form: upper case, alphabet characters only. */
function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (stripped.length !== USER_CODE_LENGTH) return null;
  for (const ch of stripped) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return stripped;
}

/** `BCDFGHJK` → `BCDF-GHJK` (what the CLI prints and the page shows). */
export function formatUserCode(code: string): string {
  return `${code.slice(0, USER_CODE_HALF)}-${code.slice(USER_CODE_HALF)}`;
}

/**
 * A user code drawn uniformly from {@link USER_CODE_ALPHABET}. Rejection
 * sampling (rather than `% length`) so no character is more likely than another
 * — a biased alphabet would shrink the effective search space.
 */
function generateUserCode(): string {
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let out = '';
  while (out.length < USER_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(USER_CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (out.length === USER_CODE_LENGTH) break;
    }
  }
  return out;
}

/** What `POST /auth/device/code` hands back to the CLI. */
export interface StartedDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  expiresAt: number;
  intervalSeconds: number;
  /** Audit correlation handle (see {@link DeviceAuthRecord.id}). */
  id: string;
}

/**
 * Open a device authorization. The returned `deviceCode` is the only copy — the
 * store holds its hash.
 */
export async function startDeviceAuthorization(params: {
  client: ClientInfo;
  stepUpRequested: boolean;
}): Promise<StartedDeviceAuthorization> {
  const now = Date.now();
  const expiresAt = now + config.auth.device.ttlMs;

  // Retry on the (astronomically unlikely) collision rather than silently
  // hijacking a live flow's code.
  let userCode: string | null = null;
  for (let attempt = 0; attempt < USER_CODE_ATTEMPTS; attempt += 1) {
    const candidate = generateUserCode();
    if (await userCodeIndex.peek(candidate) === null) {
      userCode = candidate;
      break;
    }
  }
  if (!userCode) throw new Error('DEVICE_CODE_ALLOCATION_FAILED');

  const deviceCode = crypto.randomBytes(32).toString('base64url');
  const key = codeKey(deviceCode);
  const record: DeviceAuthRecord = {
    id: key.slice(0, 12),
    userCode,
    client: params.client,
    createdAt: now,
    expiresAt,
    interval: config.auth.device.intervalSeconds,
    lastPolledAt: 0,
    polls: 0,
    status: 'pending',
    stepUpRequested: params.stepUpRequested,
  };

  await deviceCodes.put(key, record);
  await userCodeIndex.put(userCode, key);

  return { deviceCode, userCode, expiresAt, intervalSeconds: record.interval, id: record.id };
}

/** Drop both entries of a flow (deny, expiry, and the successful consume). */
async function discard(key: string, userCode: string): Promise<void> {
  await deviceCodes.remove(key);
  await deviceDecisions.remove(key);
  await userCodeIndex.remove(userCode);
}

/** A pending request located by its user code, plus its store key. */
export interface LocatedDeviceRequest {
  key: string;
  record: DeviceAuthRecord;
}

/**
 * Find a flow by user code. `'expired'` is returned (and the flow discarded) for
 * a code that existed but has lapsed, so the approval page can say so instead of
 * claiming the code never existed.
 */
export async function findByUserCode(rawUserCode: unknown): Promise<LocatedDeviceRequest | 'expired' | null> {
  const userCode = normalizeUserCode(rawUserCode);
  if (!userCode) return null;
  const key = await userCodeIndex.peek(userCode);
  if (!key) return null;
  const record = await deviceCodes.peek(key);
  // Index hit, record gone: the flow was already redeemed or explicitly
  // discarded — a real code, just no longer live.
  if (!record) {
    await userCodeIndex.remove(userCode);
    return 'expired';
  }
  if (Date.now() > record.expiresAt) {
    await discard(key, userCode);
    return 'expired';
  }
  return { key, record: await withDecision(key, record) };
}

/** Outcome of an approve/deny decision. */
export type DecisionResult = 'ok' | 'not_found' | 'expired' | 'already_decided';

/**
 * Record the browser's decision. Nothing is minted here: the CLI's next poll
 * turns `approved` into a session, which keeps token issuance on exactly one
 * code path.
 */
export async function decide(
  rawUserCode: unknown,
  decision: 'approved' | 'denied',
  approval?: DeviceApproval,
): Promise<DecisionResult> {
  const located = await findByUserCode(rawUserCode);
  if (located === 'expired') return 'expired';
  if (!located) return 'not_found';
  if (located.record.status !== 'pending') return 'already_decided';

  // Compare-and-set: written ONLY if no decision exists yet (SET NX), with the
  // flow's REMAINING life (plus the expiry grace) — a decision must not extend
  // the window. Of two racing decisions exactly one lands.
  const claimed = await deviceDecisions.putIfAbsent(
    located.key,
    { status: decision, ...(decision === 'approved' && approval ? { approval } : {}) },
    located.record.expiresAt - Date.now() + EXPIRY_GRACE_MS,
  );
  return claimed ? 'ok' : 'already_decided';
}

/** What a poll of `POST /auth/device/token` resolved to. */
export type PollResult =
  | { outcome: 'authorization_pending'; record: DeviceAuthRecord }
  | { outcome: 'slow_down'; interval: number }
  | { outcome: 'access_denied' }
  /** `existed` separates a flow that really lapsed (worth auditing once) from an
   *  unknown code, which is just a guess and must not be able to flood the audit
   *  log by being repeated. The CALLER is told the same thing either way. */
  | { outcome: 'expired_token'; existed: boolean }
  | { outcome: 'approved'; record: DeviceAuthRecord; approval: DeviceApproval };

/**
 * Advance the state machine for one poll.
 *
 * An UNKNOWN device code is reported as `expired_token` rather than a distinct
 * "no such code": the code is 256 bits of randomness, so the two cases are
 * indistinguishable to any real caller and collapsing them denies an oracle.
 *
 * `approved` CONSUMES the flow (atomic GETDEL where Redis supports it), so of
 * two racing polls exactly one is handed the approval and can mint a session.
 */
export async function poll(deviceCode: unknown): Promise<PollResult> {
  if (typeof deviceCode !== 'string' || deviceCode.length === 0) return { outcome: 'expired_token', existed: false };
  const key = codeKey(deviceCode);
  const stored = await deviceCodes.peek(key);
  if (!stored) return { outcome: 'expired_token', existed: false };
  const record = await withDecision(key, stored);

  const now = Date.now();
  if (now > record.expiresAt || record.polls >= config.auth.device.maxPolls) {
    await discard(key, record.userCode);
    return { outcome: 'expired_token', existed: true };
  }

  if (record.status === 'denied') {
    await discard(key, record.userCode);
    return { outcome: 'access_denied' };
  }

  // Polling faster than advertised: widen this flow's interval and say so. The
  // poll still counts toward the ceiling, so a hot loop burns itself out.
  const tooFast = record.lastPolledAt > 0 && now - record.lastPolledAt < record.interval * 1000 - INTERVAL_SLACK_MS;
  // Bookkeeping only — the status lives in the decision store, so this rewrite
  // can never overwrite a decision that landed between the read and the write.
  const next: DeviceAuthRecord = {
    ...stored,
    polls: record.polls + 1,
    lastPolledAt: now,
    interval: tooFast ? record.interval + SLOW_DOWN_STEP_SECONDS : record.interval,
  };
  const remainingMs = record.expiresAt - now + EXPIRY_GRACE_MS;

  if (tooFast) {
    await deviceCodes.put(key, next, remainingMs);
    return { outcome: 'slow_down', interval: next.interval };
  }

  if (record.status === 'approved' && record.approval) {
    // Single-use: the DECISION is consumed atomically (GETDEL) — the winner of a
    // race gets the approval, the loser gets nothing (and reports expired_token,
    // which is what an already-redeemed code is).
    const claimed = await deviceDecisions.consume(key);
    await deviceCodes.remove(key);
    await userCodeIndex.remove(record.userCode);
    if (!claimed || claimed.status !== 'approved' || !claimed.approval) return { outcome: 'expired_token', existed: true };
    return { outcome: 'approved', record: { ...record, approval: claimed.approval }, approval: claimed.approval };
  }

  await deviceCodes.put(key, next, remainingMs);
  return { outcome: 'authorization_pending', record: next };
}
