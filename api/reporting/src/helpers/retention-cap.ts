// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseDateRange } from '@pipeline-builder/api-core';
import { reportingService } from '@pipeline-builder/pipeline-data';
import { MAX_REPORT_RANGE_DAYS } from '../helpers.js';

const MS_PER_DAY = 86_400_000;

/** Which retention window a report reads against. */
export type RetentionKind = 'event' | 'dora';

/**
 * Shape of the retention-relevant fields on the org's reporting settings row.
 * `getIncidentSettings` returns both the per-org override (null when unset) and
 * the env default for each window — the override wins when present.
 */
interface RetentionSettings {
  eventRetentionDays: number | null;
  doraRetentionDays: number | null;
  defaultEventRetentionDays: number;
  defaultDoraRetentionDays: number;
}

/**
 * The retention horizon a per-org report is bounded to (Phase 8, D4).
 *
 * - `maxRangeMs` — the maximum `[from,to]` WIDTH (ms). Narrows `parseDateRange`'s
 *   absolute 730-day ceiling to the org's effective entitlement.
 * - `minFromMs` — the earliest `from` (epoch ms) a report may read: `now −
 *   effectiveRetentionDays·day`. `0` = unlimited (`-1`) ⇒ NO floor. Routes floor
 *   the requested `from` at this value so the returned window reflects the
 *   retention horizon (not just its width), and the frontend can render a
 *   truncation banner by comparing requested-vs-returned.
 */
export interface RetentionWindow {
  maxRangeMs: number;
  minFromMs: number;
}

/**
 * Compute the retention window (width cap + `from` floor) for the requested
 * `kind` from an ALREADY-FETCHED settings row. The effective retention is the
 * per-org override (billing-synced tier baseline + retention bundles, or a
 * manual admin override) falling back to the env default. `-1` = unlimited →
 * width clamps to the absolute ceiling (never infinity) and the floor is dropped
 * (`minFromMs = 0`).
 *
 * Split from {@link resolveOrgRetentionWindow} so the `/dora` route — which
 * already fetches `getIncidentSettings(orgId)` for its incident window — can
 * derive the window from that single call instead of re-fetching.
 */
export function orgRetentionWindowFromSettings(
  s: RetentionSettings,
  kind: RetentionKind,
  now: number = Date.now(),
): RetentionWindow {
  const eff = kind === 'dora'
    ? (s.doraRetentionDays ?? s.defaultDoraRetentionDays)
    : (s.eventRetentionDays ?? s.defaultEventRetentionDays);
  const capDays = eff === -1 ? MAX_REPORT_RANGE_DAYS : Math.min(MAX_REPORT_RANGE_DAYS, eff);
  const maxRangeMs = capDays * MS_PER_DAY;
  const minFromMs = eff === -1 ? 0 : Math.max(0, now - eff * MS_PER_DAY);
  return { maxRangeMs, minFromMs };
}

/**
 * Resolve the per-org retention window (width cap + `from` floor) for the given
 * retention `kind`. Self-contained: reads reporting's own `dora_settings` via
 * `getIncidentSettings` (never pipeline-data resolver internals).
 */
export async function resolveOrgRetentionWindow(
  orgId: string,
  kind: RetentionKind,
  now: number = Date.now(),
): Promise<RetentionWindow> {
  const s = await reportingService.getIncidentSettings(orgId);
  return orgRetentionWindowFromSettings(s as RetentionSettings, kind, now);
}

/**
 * Floor an already-parsed `[from,to]` at the retention horizon: `from =
 * max(from, minFromMs)`, never moving `from` past `to`. `minFromMs <= 0` (or a
 * non-finite value) = unlimited ⇒ the range is returned unchanged.
 */
export function floorFrom(
  range: { from: string; to: string },
  minFromMs: number,
): { from: string; to: string } {
  if (!(minFromMs > 0)) return range;
  const fromMs = Date.parse(range.from);
  if (!Number.isFinite(fromMs) || fromMs >= minFromMs) return range;
  const toMs = Date.parse(range.to);
  const floored = Number.isFinite(toMs) ? Math.min(minFromMs, toMs) : minFromMs;
  return { from: new Date(floored).toISOString(), to: range.to };
}

/**
 * Parse a `?from&to` query for a PER-ORG report route, capped AND floored to the
 * org's effective retention window for `kind`. The single entry point the per-org
 * report routes use so the width-cap + `from`-floor can't drift between them.
 * (System-admin cross-org routes deliberately bypass this — they keep the
 * absolute ceiling and no floor.)
 */
export async function parseOrgReportRange(
  query: Record<string, unknown>,
  orgId: string,
  kind: RetentionKind,
): Promise<{ from: string; to: string } | { error: string }> {
  const win = await resolveOrgRetentionWindow(orgId, kind);
  const range = parseDateRange(query, { maxRangeMs: win.maxRangeMs });
  if ('error' in range) return range;
  return floorFrom(range, win.minFromMs);
}
