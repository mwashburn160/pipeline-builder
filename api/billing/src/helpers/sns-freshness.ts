// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Replay window for signed SNS messages.
 *
 * The SNS route dedupes on `MessageId` with a `done` marker that expires after
 * {@link WEBHOOK_DONE_TTL_SECONDS}. A captured, validly SIGNED message replayed
 * after that marker is reaped would be claimed and processed again (a stale
 * license event re-applied). `Timestamp` is part of the signed string, so it
 * cannot be altered without breaking the signature: rejecting anything older
 * than the dedupe window (minus a day of margin) closes the replay, and
 * rejecting a timestamp far in the future stops a message minted with a
 * forward-dated clock from outliving the window the other way.
 */

import { WEBHOOK_DONE_TTL_SECONDS } from '../config/webhook-retention.js';

/** Oldest accepted message: one day inside the dedupe marker's lifetime. */
export const SNS_MAX_MESSAGE_AGE_MS = (WEBHOOK_DONE_TTL_SECONDS - 24 * 60 * 60) * 1000;

/** Tolerated clock skew for a message stamped in the future. */
export const SNS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Why a (signature-verified) SNS message's `Timestamp` is unacceptable, or null
 * when it is inside the replay window. A missing/unparseable timestamp is
 * rejected — SNS always signs one.
 */
export function snsTimestampProblem(timestamp: unknown, now: number = Date.now()): 'missing' | 'too_old' | 'in_future' | null {
  if (typeof timestamp !== 'string' || !timestamp) return 'missing';
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return 'missing';
  if (now - at > SNS_MAX_MESSAGE_AGE_MS) return 'too_old';
  if (at - now > SNS_MAX_FUTURE_SKEW_MS) return 'in_future';
  return null;
}
