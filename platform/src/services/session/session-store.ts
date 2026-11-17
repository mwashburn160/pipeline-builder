// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place that reads and writes refresh-session slots (the
 * `refresh_sessions` collection, `models/refresh-session.ts`).
 *
 * Every caller — sign-in, refresh, switch-org, sign-out, the hard-revocation
 * sites, the sessions list and the auth middleware — goes through these
 * functions, so the validity rule lives in one module: a slot is live only
 * while its `tokenVersion` equals the user's current one.
 *
 * The model is loaded on demand, and nothing but types is imported: the auth
 * middleware and every hard-revocation site import this module, and must not
 * pull the model graph (or config) in at link time — the same reason
 * `helpers/bootstrap-admin.ts` and `org-policy-lineage.ts` load lazily. When a
 * slot may be purged (`purgeAt`) is decided by the caller (`purgeAtFor` in
 * refresh-sessions.ts).
 */

import type { ClientSession, Types } from 'mongoose';
import type { RefreshSessionKind } from '../../constants/vocabulary.js';
import type { RefreshSessionData } from '../../models/refresh-session.js';

/** A slot as stored (lean), without the owning user id. */
export type RefreshSession = Omit<RefreshSessionData, 'userId'> & { userId?: Types.ObjectId | string };

type UserId = Types.ObjectId | string;

async function model() {
  return (await import('../../models/index.js')).RefreshSession;
}

/**
 * Store a new slot, then apply its kind's cap to that kind only — the other
 * kind is never touched:
 *   - interactive: keep the newest `cap` by creation;
 *   - machine: keep the `cap` most recently used (the new slot is the newest use).
 * Returns the ids the cap evicted (the caller publishes their revocation).
 *
 * Two concurrent sign-ins may both trim; each trim keeps the newest `cap`, so
 * the result is the same either way.
 */
export async function insertSlot(userId: UserId, slot: RefreshSession, cap: number): Promise<string[]> {
  const RefreshSession = await model();
  await RefreshSession.create({ ...slot, userId });
  const sortBy: Record<string, 1 | -1> = slot.kind === 'interactive'
    ? { createdAt: -1, _id: -1 }
    : { lastUsedAt: -1, _id: -1 };
  const surplus = await RefreshSession.find({ userId, kind: slot.kind })
    .sort(sortBy).skip(cap).select('id').lean();
  if (surplus.length === 0) return [];
  const ids = surplus.map((s) => s.id);
  await RefreshSession.deleteMany({ userId, id: { $in: ids } });
  return ids;
}

/** One slot of `userId`, or `undefined` when it no longer exists. */
export async function findSlot(userId: UserId, sessionId: string): Promise<RefreshSession | undefined> {
  const RefreshSession = await model();
  const doc = await RefreshSession.findOne({ userId, id: sessionId }).lean();
  return (doc as RefreshSession | null) ?? undefined;
}

/**
 * Whether slot `sessionId` is live for a user at `tokenVersion` — the check the
 * auth middleware makes for every access token carrying a `sid`.
 */
export async function slotIsLive(userId: UserId, sessionId: string, tokenVersion: number): Promise<boolean> {
  const RefreshSession = await model();
  return !!(await RefreshSession.exists({ userId, id: sessionId, tokenVersion }));
}

/**
 * The atomic compare-and-set every re-issue uses: apply `set` to the slot only
 * while it still matches `match` (its id, its user's `tokenVersion`, its kind
 * and scope as read, and — on refresh — the presented token's hash). Returns
 * whether the write landed: of two racing uses of one refresh token exactly
 * one does.
 */
export async function updateSlotIf(
  userId: UserId,
  match: { id: string; tokenVersion: number; kind: RefreshSessionKind; scope: string | null; hash?: string },
  set: Record<string, unknown>,
): Promise<boolean> {
  const RefreshSession = await model();
  const updated = await RefreshSession.findOneAndUpdate(
    { userId, ...match },
    { $set: set },
    { projection: { _id: 1 } },
  ).lean();
  return !!updated;
}

/** Drop one slot (sign-out of one device, reuse, an expired session). */
export async function deleteSlot(userId: UserId, sessionId: string): Promise<void> {
  const RefreshSession = await model();
  await RefreshSession.deleteOne({ userId, id: sessionId });
}

/**
 * Drop EVERY slot of the given user(s) — the companion of a hard revocation.
 * Pass the transaction's `session` when the revocation is transactional, so the
 * slots go exactly when the bump commits.
 */
export async function deleteAllSlots(userIds: UserId | readonly UserId[], session?: ClientSession | null): Promise<void> {
  const RefreshSession = await model();
  const ids = Array.isArray(userIds) ? [...userIds] : [userIds as UserId];
  if (ids.length === 0) return;
  await RefreshSession.deleteMany({ userId: { $in: ids } }, session ? { session } : {});
}

/** The user's live slots (at `tokenVersion`), in no particular order. */
export async function listSlots(userId: UserId, tokenVersion: number): Promise<RefreshSession[]> {
  const RefreshSession = await model();
  return (await RefreshSession.find({ userId, tokenVersion }).lean()) as RefreshSession[];
}

/** Lift the bootstrap-admin enrolment limit from every slot of `userId`. */
export async function clearEnrollmentPending(userId: UserId): Promise<void> {
  const RefreshSession = await model();
  await RefreshSession.updateMany({ userId, mfaEnrollmentPending: true }, { $unset: { mfaEnrollmentPending: '' } });
}
