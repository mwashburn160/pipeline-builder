// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** A step-up-gated service-account action, held by the section until the user re-confirms. */
export type ServiceAccountAction =
  | { kind: 'create'; name: string; description?: string; roleIds: string[]; tokenBudget: number }
  | { kind: 'details'; accountId: string; accountName: string; changes: { description?: string | null; tokenBudget?: number } }
  | { kind: 'key'; accountId: string; accountName: string; name: string; expiresIn: number; ipAllowlist: string[]; scope: string }
  | { kind: 'toggle'; accountId: string; accountName: string; disabled: boolean }
  | { kind: 'roles'; accountId: string; accountName: string; roleIds: string[]; roleNames: string[] }
  | { kind: 'delete'; accountId: string; name: string; keyCount: number };

/**
 * Parse the token-budget field: empty = unlimited (-1), otherwise a whole number
 * of exchanges per period, at least 1 — the same rule as the API's schema.
 * Returns null for anything else.
 */
export function parseTokenBudget(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return -1;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

export const BUDGET_HINT = 'Token exchanges per period. Leave empty for unlimited.';
export const BUDGET_ERROR = 'Token budget must be a whole number of at least 1, or empty for unlimited';
