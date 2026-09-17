// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { formatCents } from '@/lib/format';
import type { Discount } from '@/types';

/** Human-readable discount amount+kind, e.g. "50% one-time", "$25.00 recurring",
 *  "$100.00 credit". `value` is percent-points for `percent`, else whole CENTS —
 *  so dollar/credit amounts must go through `formatCents`, not raw `$${value}`
 *  (which rendered a $25 discount as "$2500"). */
export function formatDiscount(d: Discount): string {
  const amount = d.unit === 'percent' ? `${d.value}%` : formatCents(d.value);
  const kindLabel = d.kind === 'onetime' ? 'one-time' : d.kind;
  return `${amount} ${kindLabel}`;
}
