// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isoDate } from '@pipeline-builder/api-core';

/**
 * The key that scopes "grant once per billing period": the UTC date the period
 * STARTS on (`2026-11-16`).
 *
 * One key per period whatever the month length or payment timing. It used to
 * be the calendar month of the moment the code ran (`2026-11`), which is not the
 * period: a subscription anchored on the 31st whose Mar 31 renewal settled on a
 * retry on Apr 1 keyed that period `2026-04`, and its Apr 30 renewal keyed
 * `2026-04` again, so the second period's recurring credits and promotions were
 * skipped as already granted. Annual plans had the same flaw with years.
 *
 * Keying on the period start (rather than an invoice id) still lets several
 * invoices in one period (a proration, a one-off) share one grant.
 */
export function billingPeriodKey(periodStart: Date): string {
  return isoDate(periodStart);
}
