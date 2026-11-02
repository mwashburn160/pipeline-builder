// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/format';
import { formatRelativeTime } from '@/lib/relative-time';
import { SCAN_STALE_AFTER_HOURS, scanAgeHours } from '@/lib/plugin-vulns';

/**
 * How old a version's last vulnerability scan is: "Scanned 2 days ago", turned
 * yellow ("Scan stale") past `staleAfterHours` — the window after which lookup
 * warns `SCAN_STALE`, because a scan says nothing about advisories published
 * since. Renders nothing without a scan time (VulnSummary's "Unscanned" covers that).
 */
export function ScanAgeBadge({ scannedAt, staleAfterHours = SCAN_STALE_AFTER_HOURS, now }: {
  scannedAt: string | null | undefined;
  staleAfterHours?: number;
  /** Test hook: the clock. */
  now?: number;
}) {
  const age = scanAgeHours(scannedAt, now);
  if (age === null || !scannedAt) return null;
  const stale = age >= staleAfterHours;
  const title = `Last scanned ${formatDateTime(scannedAt)}.${stale ? ` Older than ${staleAfterHours}h, so advisories published since are not reflected.` : ''}`;
  return (
    <span title={title} className="inline-block" data-testid={stale ? 'scan-age-stale' : 'scan-age'}>
      <Badge color={stale ? 'yellow' : 'gray'}>
        <Clock className="mr-1 h-3 w-3" aria-hidden />
        {stale ? 'Scan stale · ' : 'Scanned '}{formatRelativeTime(new Date(scannedAt), now)}
      </Badge>
    </span>
  );
}
