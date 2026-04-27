// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Format a Date or ISO string as a short relative-time label
 * ("just now", "2m ago", "3h ago", "5d ago"). Falls back to a localized
 * absolute date string for anything older than 30 days.
 *
 * Uses Intl.RelativeTimeFormat (Node 12+, all modern browsers) — no deps.
 */
const RTF = typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
  ? new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
  : null;

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(value: string | Date | number, now: number = Date.now()): string {
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ts)) return '';

  const diffMs = ts - now;
  const absMs = Math.abs(diffMs);

  if (absMs < 30 * SECOND_MS) return 'just now';
  if (!RTF) return new Date(ts).toLocaleString();

  if (absMs < HOUR_MS) return RTF.format(Math.round(diffMs / MINUTE_MS), 'minute');
  if (absMs < DAY_MS) return RTF.format(Math.round(diffMs / HOUR_MS), 'hour');
  if (absMs < 30 * DAY_MS) return RTF.format(Math.round(diffMs / DAY_MS), 'day');

  return new Date(ts).toLocaleDateString();
}
