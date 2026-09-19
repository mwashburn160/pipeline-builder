// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { OrgIdpConfigCreate, OrgIdpConfigDto } from '@/types';

/**
 * Empty-ish values collapse to `undefined` and objects drop their empty keys,
 * so `''` / `null` / a missing field / `{ email: '' }` all compare as "unset".
 * The editors send `''` to mean "clear", while the stored config simply omits
 * the field — without this, every save would report those as changes.
 */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, normalize(v)] as const)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * The PATCH body that moves `config` to `desired`: only the fields whose value
 * actually changes. `undefined` in `desired` means "not this editor's field".
 *
 * `clientSecret` is write-only — the stored config never carries it — so it is
 * included exactly when the admin typed one (rotation), and never otherwise.
 * An empty result means there is nothing to save.
 */
export function changedIdpFields(
  config: OrgIdpConfigDto,
  desired: Partial<OrgIdpConfigCreate>,
): Partial<OrgIdpConfigCreate> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    if (key === 'clientSecret') {
      if (typeof value === 'string' && value.trim()) patch[key] = value;
      continue;
    }
    if (!same((config as unknown as Record<string, unknown>)[key], value)) patch[key] = value;
  }
  return patch as Partial<OrgIdpConfigCreate>;
}
