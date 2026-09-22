// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { clampRetentionDays, parseDateRange, RETENTION_MAX_DAYS, RETENTION_UNLIMITED } from '@pipeline-builder/api-core';
import { reportingService, type ReportingSettings } from '@pipeline-builder/pipeline-data';

const MS_PER_DAY = 86_400_000;

/**
 * The org whose retention governs a request's reports: the account ROOT.
 * Retention is a billing entitlement that billing syncs onto the root only, so a
 * team must read its root's window (else it'd be capped at the env default while
 * the account paid for more). The root comes from the verified JWT
 * (`rootOrganizationId`, absent on a flat org). A sysadmin acting on another org
 * via the header override carries claims about their OWN org, so they read the
 * target org's own row.
 */
export function retentionOrgIdFor(
  req: { user?: { isSuperAdmin?: boolean; organizationId?: string; rootOrganizationId?: string } },
  orgId: string,
): string {
  const user = req.user;
  if (!user || user.isSuperAdmin === true || user.organizationId !== orgId) return orgId;
  return user.rootOrganizationId ?? orgId;
}

/** Which retention window a report reads against. */
export type RetentionKind = 'event' | 'dora';

/**
 * The retention-relevant fields of the org's reporting settings: the per-org
 * override (null when unset) and the env default for each window — the
 * override wins when present.
 */
export type RetentionSettings = Pick<ReportingSettings, 'eventRetentionDays' | 'doraRetentionDays' | 'defaultEventRetentionDays' | 'defaultDoraRetentionDays'>;

/**
 * The retention horizon a per-org report is bounded to.
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
 * The org's effective retention (days) for `kind`: the per-org override
 * (billing-synced tier baseline + retention bundles) falling back to the env
 * default. `-1` = unlimited.
 */
export function effectiveRetentionDays(s: RetentionSettings, kind: RetentionKind): number {
  return kind === 'dora'
    ? (s.doraRetentionDays ?? s.defaultDoraRetentionDays)
    : (s.eventRetentionDays ?? s.defaultEventRetentionDays);
}

/**
 * The widest `[from,to]` span (days) a report may cover under an effective
 * retention of `effDays`: the retention itself, clamped to the absolute
 * {@link RETENTION_MAX_DAYS} ceiling (unlimited `-1` ⇒ the ceiling).
 */
export function maxRangeDaysFor(effDays: number): number {
  return effDays === RETENTION_UNLIMITED ? RETENTION_MAX_DAYS : clampRetentionDays(effDays);
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
 * already fetches `getReportingSettings(orgId)` for its incident window — can
 * derive the window from that single call instead of re-fetching.
 */
export function orgRetentionWindowFromSettings(
  s: RetentionSettings,
  kind: RetentionKind,
  now: number = Date.now(),
): RetentionWindow {
  const eff = effectiveRetentionDays(s, kind);
  const maxRangeMs = maxRangeDaysFor(eff) * MS_PER_DAY;
  const minFromMs = eff === -1 ? 0 : Math.max(0, now - eff * MS_PER_DAY);
  return { maxRangeMs, minFromMs };
}

/**
 * Resolve the per-org retention window (width cap + `from` floor) for the given
 * retention `kind`. Self-contained: reads reporting's own `dora_settings` via
 * `getReportingSettings` (never pipeline-data resolver internals).
 */
export async function resolveOrgRetentionWindow(
  orgId: string,
  kind: RetentionKind,
  retentionOrgId: string,
  now: number = Date.now(),
): Promise<RetentionWindow> {
  const s = await reportingService.getReportingSettings(orgId, retentionOrgId);
  return orgRetentionWindowFromSettings(s, kind, now);
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
  /** The account root whose retention applies — see {@link retentionOrgIdFor}. */
  retentionOrgId: string,
): Promise<{ from: string; to: string } | { error: string }> {
  const win = await resolveOrgRetentionWindow(orgId, kind, retentionOrgId);
  const range = parseDateRange(query, { maxRangeMs: win.maxRangeMs });
  if ('error' in range) return range;
  return floorFrom(range, win.minFromMs);
}
