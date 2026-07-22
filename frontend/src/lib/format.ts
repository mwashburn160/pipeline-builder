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
