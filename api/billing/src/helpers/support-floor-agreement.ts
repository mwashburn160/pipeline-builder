// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A subscription's NEGOTIATED support floor (`supportFloorOverride`, set by
 * PUT /billing/admin/subscriptions/:id/support-floor), as the ADMIN
 * subscription read shows it so the billing console can show and prefill the
 * agreement on file. Admin-only: the customer's own subscription read does not
 * carry it (the agreed price is a vendor record, and `agreedBy` names staff).
 */

/** The agreement on file. `floorCents` is per month; dates are ISO strings. */
export interface SupportFloorAgreement {
  seats: number;
  floorCents: number;
  agreedAt: string;
  /** The operator's user id. */
  agreedBy: string;
  note?: string;
}

/** The stored override, as the model holds it. */
interface StoredOverride {
  seats: number;
  floorCents: number;
  agreedAt: Date;
  agreedBy: string;
  note?: string;
}

/** The agreement on file, or null when there is none. Copies only its own fields. */
export function supportFloorAgreementView(subscription: { supportFloorOverride?: StoredOverride | null }): SupportFloorAgreement | null {
  const o = subscription.supportFloorOverride;
  if (!o) return null;
  return {
    seats: o.seats,
    floorCents: o.floorCents,
    agreedAt: new Date(o.agreedAt).toISOString(),
    agreedBy: o.agreedBy,
    ...(o.note ? { note: o.note } : {}),
  };
}
