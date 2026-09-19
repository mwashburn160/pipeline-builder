// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reports freshness indicator.
 *
 * Execution / DORA reports are computed over events the AWS forwarder pushes
 * into the reporting service. Without this strip an empty chart is ambiguous:
 * it looks identical whether the org simply shipped nothing in the range or the
 * ingest pipeline has been down for a week. The forwarder already writes a
 * heartbeat (`POST /reports/ingest-health`); this renders the matching read.
 *
 * The four states it distinguishes — and the wording is deliberately literal,
 * because the honest statement is the useful one:
 *
 *  - `never`    no row at all. The deployment has NEVER reported ingestion.
 *               Said plainly; calling that "stale" would invent a regression
 *               that never happened, and on a fresh install it is simply the
 *               forwarder not being wired up yet.
 *  - `dropping` the forwarder reports dropped events — reports are missing data
 *               regardless of how fresh the heartbeat is, so this outranks
 *               everything below.
 *  - `stale`    nothing has reached the ingest pipeline since the reported time.
 *               The heartbeat only fires when the forwarder actually forwards,
 *               so this means "no events since X" — a broken forwarder and a
 *               genuinely idle account look the same from here, and the copy
 *               says exactly that instead of guessing which one it is.
 *  - `flowing`  a recent heartbeat, so ingestion is alive: an empty report for
 *               the selected range really is a quiet range.
 */

import { Activity, AlertTriangle, CircleSlash, Clock } from 'lucide-react';
import { RelativeTime } from '@/components/ui/RelativeTime';
import type { IngestHealthResponse } from '@/lib/api/domains/reporting';

/**
 * How long without a heartbeat before ingestion is called stale. The forwarder
 * posts at most once a minute and only after it forwards something, so this is
 * sized for "a whole working day with no pipeline activity at all", not for the
 * heartbeat interval — a tighter bound would flag every quiet weekend.
 */
export const INGEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type IngestState = 'never' | 'flowing' | 'stale' | 'dropping';

export interface IngestStatus {
  state: IngestState;
  /** The instant the copy refers to (heartbeat / last event), or null for `never`. */
  since: string | null;
  /** Events the forwarder reports dropping (only meaningful for `dropping`). */
  dropped: number;
}

/**
 * Classify an ingest-health response. Pure, and measured against the SERVER's
 * `now` so a skewed browser clock can neither fake nor mask staleness.
 */
export function classifyIngestHealth(
  res: IngestHealthResponse | null | undefined,
  staleAfterMs = INGEST_STALE_AFTER_MS,
): IngestStatus {
  if (!res || !res.health) return { state: 'never', since: null, dropped: 0 };
  const { health, now } = res;
  const dropped = health.dropped ?? 0;
  if (dropped > 0) return { state: 'dropping', since: health.updatedAt, dropped };
  const nowMs = Date.parse(now);
  const beatMs = Date.parse(health.updatedAt);
  // An unparsable timestamp on either side is not evidence of staleness —
  // report what we have rather than manufacturing an alarm.
  const age = Number.isFinite(nowMs) && Number.isFinite(beatMs) ? nowMs - beatMs : 0;
  if (age > staleAfterMs) {
    return { state: 'stale', since: health.lastEventAt ?? health.updatedAt, dropped };
  }
  return { state: 'flowing', since: health.lastEventAt ?? health.updatedAt, dropped };
}

const TONE: Record<IngestState, { icon: typeof Activity; className: string }> = {
  flowing: { icon: Activity, className: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300' },
  stale: { icon: Clock, className: 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300' },
  dropping: { icon: AlertTriangle, className: 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' },
  never: { icon: CircleSlash, className: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 text-gray-600 dark:text-gray-400' },
};

/**
 * One-line freshness strip for the report tabs computed from ingested events.
 * Renders nothing while the first read is in flight or when it failed — a
 * freshness widget that itself can't report is worse than no widget.
 */
export function IngestFreshness({ data, loading, error }: {
  data: IngestHealthResponse | null | undefined;
  loading: boolean;
  error?: string | null;
}) {
  if (loading || error || data === undefined) return null;

  const status = classifyIngestHealth(data);
  const { icon: Icon, className } = TONE[status.state];

  return (
    <div
      role="status"
      data-testid="ingest-freshness"
      data-state={status.state}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${className}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {status.state === 'never' && (
        <span>
          No ingestion has been reported yet — this deployment has never received pipeline events,
          so these reports are empty for lack of data, not lack of activity.
        </span>
      )}
      {status.state === 'flowing' && (
        <span>
          Ingestion is healthy — events last received <RelativeTime value={status.since} live />.
          An empty chart means no activity in the selected range.
        </span>
      )}
      {status.state === 'stale' && (
        <span>
          No events have reached the ingest pipeline since <RelativeTime value={status.since} live />.
          Reports after that point are empty because nothing arrived — check the event forwarder if
          you expected activity.
        </span>
      )}
      {status.state === 'dropping' && (
        <span>
          The ingest pipeline reports {status.dropped.toLocaleString()} dropped event
          {status.dropped === 1 ? '' : 's'} (last heard <RelativeTime value={status.since} live />).
          These reports are missing data until that clears.
        </span>
      )}
    </div>
  );
}
