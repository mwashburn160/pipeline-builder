// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Schema, model, type HydratedDocument } from 'mongoose';

/**
 * The delivery health of one org alert destination (a Postgres
 * `org_alert_destinations` row, keyed here by its id): when the relay last
 * reached it, whether that worked, and how many attempts in a row have failed.
 *
 * Written best-effort by the relay after every real delivery attempt
 * (services/alert-delivery-status.ts) and shown in the org's destinations list,
 * so an org whose Slack webhook was revoked SEES it instead of hearing silence.
 * TTL'd on `lastAttemptAt` (see below), so it needs no org-cascade leg.
 *
 * `lastErrorKind` is a CLASS (timeout / rejected / unreachable /
 * unknown-channel), never the downstream status code or host — the same reason
 * the test-send route answers with a generic 502: an org controls the URL, and
 * a precise error would make the relay an oracle for probing internal endpoints.
 */
export const DELIVERY_ERROR_KINDS = ['timeout', 'rejected', 'unreachable', 'unknown-channel'] as const;
export type DeliveryErrorKind = typeof DELIVERY_ERROR_KINDS[number];

export interface AlertDestinationStatusData {
  destinationId: string;
  orgId: string;
  channel: string;
  lastAttemptAt: Date;
  lastOk: boolean;
  lastErrorKind?: DeliveryErrorKind | null;
  lastSuccessAt?: Date | null;
  lastFailureAt?: Date | null;
  /** Failed attempts since the last success. */
  consecutiveFailures: number;
  /** When the org's admins were told this destination is failing (cleared on the next success). */
  notifiedAt?: Date | null;
}

export type AlertDestinationStatusDocument = HydratedDocument<AlertDestinationStatusData>;

const alertDestinationStatusSchema = new Schema<AlertDestinationStatusData>(
  {
    destinationId: { type: String, required: true, unique: true },
    orgId: { type: String, required: true, index: true },
    channel: { type: String, required: true },
    lastAttemptAt: { type: Date, required: true },
    lastOk: { type: Boolean, required: true },
    lastErrorKind: { type: String, enum: [...DELIVERY_ERROR_KINDS, null], default: null },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, required: true, default: 0 },
    notifiedAt: { type: Date, default: null },
  },
  { collection: 'alert_destination_status', versionKey: false },
);

// A destination nothing has tried to reach for 30 days — deleted, disabled, or
// in an org that was purged — drops out on its own. That keeps this
// operational record out of the org cascade and inside the privacy policy's
// 30-day window for deleted items.
export const DESTINATION_STATUS_TTL_SECONDS = 30 * 86_400;
alertDestinationStatusSchema.index({ lastAttemptAt: 1 }, { expireAfterSeconds: DESTINATION_STATUS_TTL_SECONDS });

export default model<AlertDestinationStatusData>('AlertDestinationStatus', alertDestinationStatusSchema);
