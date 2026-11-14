// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { RelativeTime } from '@/components/ui/RelativeTime';
import type { AlertDeliveryErrorKind, AlertDestinationDelivery } from '@/types/observability';

/**
 * Plain words for the relay's error CLASS. The relay deliberately never returns
 * the downstream status code or host (an org controls the URL, so a precise
 * error would make it a probe oracle) — these classes are all there is.
 */
const ERROR_KIND_LABEL: Record<AlertDeliveryErrorKind, string> = {
  timeout: 'timed out',
  rejected: 'rejected by the destination',
  unreachable: 'unreachable',
  'unknown-channel': 'unknown channel',
};

/**
 * One destination's last delivery outcome, from the `delivery` block the
 * destinations list carries: "Never attempted", "Last delivered <time>", or
 * "Failing (N in a row): <kind>" with when it last worked.
 */
export function AlertDeliveryStatus({ delivery }: { delivery: AlertDestinationDelivery | null | undefined }) {
  if (!delivery) return <span className="text-xs text-fg-subtle">Never attempted</span>;
  if (delivery.lastOk) {
    return (
      <span className="text-xs text-success-strong" data-testid="alert-delivery-ok">
        Last delivered <RelativeTime value={delivery.lastSuccessAt ?? delivery.lastAttemptAt} />
      </span>
    );
  }
  const kind = delivery.lastErrorKind ? ERROR_KIND_LABEL[delivery.lastErrorKind] : 'failed';
  return (
    <span className="text-xs text-danger-strong" data-testid="alert-delivery-failing">
      Failing ({delivery.consecutiveFailures} in a row): {kind}
      <span className="block text-2xs text-fg-subtle">
        {delivery.lastSuccessAt
          ? <>last delivered <RelativeTime value={delivery.lastSuccessAt} /></>
          : 'never delivered'}
      </span>
    </span>
  );
}
