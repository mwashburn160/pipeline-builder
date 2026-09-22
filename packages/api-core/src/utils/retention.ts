// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The reporting-retention bounds, shared by billing (which computes and pushes
 * an org's effective entitlement), reporting (which accepts it and caps report
 * ranges) and the data layer (which sweeps).
 */
export const RETENTION_MIN_DAYS = 1;
/** Absolute ceiling (days) for retained data and report ranges. */
export const RETENTION_MAX_DAYS = 730;
/** The "keep forever" sentinel an unlimited tier carries. */
export const RETENTION_UNLIMITED = -1;

/** Clamp a retention to the ceiling; the unlimited sentinel passes through. */
export function clampRetentionDays(days: number): number {
  return days === RETENTION_UNLIMITED ? RETENTION_UNLIMITED : Math.min(days, RETENTION_MAX_DAYS);
}

/**
 * Validate an untrusted retention value: the unlimited sentinel, or an integer
 * ≥ 1 clamped to the ceiling. Anything else (non-integer, 0, < -1) → `null`.
 */
export function normalizeRetentionDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value === RETENTION_UNLIMITED) return RETENTION_UNLIMITED;
  if (value < RETENTION_MIN_DAYS) return null;
  return clampRetentionDays(value);
}
