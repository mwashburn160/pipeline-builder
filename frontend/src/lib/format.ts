// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tight number / byte formatters used in tables and stat cards.
 * Centralized so registry, billing, and any future surface that
 * displays sizes share the same rounding rules.
 */

/**
 * Format a count for display: locale-grouped digits, with `-1` (the quota
 * "unlimited" sentinel) rendered as the infinity glyph. Any non-sentinel
 * value formats identically to `n.toLocaleString()`.
 */
export function fmtNum(n: number): string {
  return n === -1 ? '∞' : n.toLocaleString();
}

/**
 * Render a cents amount as USD (locale-grouped, two decimals), e.g. 123450 →
 * "$1,234.50". The single money formatter shared by every billing surface, so
 * large amounts render consistently (thousands separators included).
 */
export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Render a byte count in the largest unit that keeps the value < 1024.
 * Values < 10 keep one decimal (e.g. "1.2 MB"); larger values round to
 * the nearest integer (e.g. "240 MB"). Negative or non-finite inputs
 * yield "0 B" — callers that want a custom empty-state (e.g. "—")
 * should branch before calling.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < BYTE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return value < 10 ? `${value.toFixed(1)} ${BYTE_UNITS[i]}` : `${Math.round(value)} ${BYTE_UNITS[i]}`;
}

/**
 * Null-safe absolute date+time for display (locale-formatted). Empty/invalid
 * input renders the em-dash placeholder. The single date-time formatter shared
 * across edit modals, compliance, and registry surfaces (which each hand-rolled
 * `new Date(x).toLocaleString()` + their own null guard).
 */
export function formatDateTime(iso: string | number | Date | null | undefined, placeholder = '—'): string {
  if (iso == null || iso === '') return placeholder;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? placeholder : d.toLocaleString();
}

/**
 * Null-safe time-of-day (no date) — for timelines scoped to a single day or run
 * (a scan's step log, a "last refreshed" stamp), where repeating the date on
 * every row is noise. Still centralized so the app has ONE set of date
 * formatters rather than scattered `toLocaleTimeString()` calls.
 */
export function formatTime(iso: string | number | Date | null | undefined, placeholder = '—'): string {
  if (iso == null || iso === '') return placeholder;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? placeholder : d.toLocaleTimeString();
}

/** Null-safe absolute date (no time) for display. See {@link formatDateTime}. */
export function formatDate(iso: string | number | Date | null | undefined, placeholder = '—'): string {
  if (iso == null || iso === '') return placeholder;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? placeholder : d.toLocaleDateString();
}

/**
 * Null-safe spelled-out date — "February 25, 2026" in en-US. For prose and
 * headline dates (a grace-period deadline, a billing period bound) where the
 * numeric `formatDate` form reads as a code.
 *
 * Three copies of this lived in components (`MfaPolicySettings`, `TeamsCard`,
 * `billing/helpers`), and the billing one pinned `'en-US'` — so one date in the
 * billing page ignored the user's locale while every other date on it obeyed.
 * The locale is left to the platform here, like every other formatter in this
 * file.
 */
export function formatDateLong(iso: string | number | Date | null | undefined, placeholder = '—'): string {
  if (iso == null || iso === '') return placeholder;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? placeholder
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Null-safe abbreviated-month date — "Feb 25, 2026" in en-US. {@link formatDateLong}
 * where the surface is tight (a card line, a table cell) but a numeric date
 * would still be ambiguous.
 */
export function formatDateMedium(iso: string | number | Date | null | undefined, placeholder = '—'): string {
  if (iso == null || iso === '') return placeholder;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? placeholder
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Humanize an elapsed duration in MILLISECONDS → "850ms", "45s", "5m 3s",
 * "1h 2m", "2d 3h". Null/negative → the placeholder.
 *
 * The app had three of these: `fmtMs` in the reports helpers rendered
 * milliseconds as "2.1m", `formatDuration` on the pipeline detail page rendered
 * the SAME input as "2m 5s", and `fmtSeconds` covered hours/days but only from
 * seconds. So one build's elapsed time read differently depending on the page.
 * This is the union of all three: the precise m/s style, the full ms→days
 * range, and null-safety.
 */
export function formatDuration(ms: number | null | undefined, placeholder = '—'): string {
  if (ms == null || ms < 0) return placeholder;
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** {@link formatDuration} for a value already in SECONDS. */
export function formatDurationSeconds(seconds: number | null | undefined, placeholder = '—'): string {
  return seconds == null ? placeholder : formatDuration(seconds * 1000, placeholder);
}
