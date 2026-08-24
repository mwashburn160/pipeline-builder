// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pkg#9 — the quota-admin editor's tier presets are served from the platform
 * `/config` payload (env-override-aware) with the hardcoded table as a fail-soft
 * fallback. `buildTierPresets` overlays server-provided limits onto that fallback:
 * undefined → fallback unchanged; a partial payload merges per-field; the static
 * `TIER_PRESETS` export is the fallback source.
 */

import { buildTierPresets, TIER_PRESETS } from '../src/components/quotas/constants';

describe('buildTierPresets (pkg#9 server-sourced tier presets)', () => {
  it('returns the hardcoded fallback when no server presets are provided', () => {
    expect(buildTierPresets(undefined)).toBe(TIER_PRESETS);
  });

  it('overlays server-provided limits over the fallback', () => {
    const built = buildTierPresets({
      pro: { pipelines: 999, plugins: 888, apiCalls: 777_000, aiCalls: 666 },
    });
    // Pro reflects the server's env-override values...
    expect(built.pro.limits).toEqual({ pipelines: 999, plugins: 888, apiCalls: 777_000, aiCalls: 666 });
    // ...while labels/descriptions/colors stay local (not server-sourced).
    expect(built.pro.label).toBe(TIER_PRESETS.pro.label);
    expect(built.pro.color).toBe(TIER_PRESETS.pro.color);
    // A tier the server omitted keeps its hardcoded fallback limits.
    expect(built.developer.limits).toEqual(TIER_PRESETS.developer.limits);
  });

  it('merges per-field: an omitted field keeps the fallback value', () => {
    const built = buildTierPresets({ team: { pipelines: 50 } as never });
    expect(built.team.limits.pipelines).toBe(50);
    // plugins/apiCalls/aiCalls fall back to the hardcoded table.
    expect(built.team.limits.plugins).toBe(TIER_PRESETS.team.limits.plugins);
    expect(built.team.limits.apiCalls).toBe(TIER_PRESETS.team.limits.apiCalls);
  });

  it('ignores non-numeric / non-finite server values (fail-soft)', () => {
    const built = buildTierPresets({
      enterprise: { pipelines: NaN as never, plugins: 'x' as never, apiCalls: 123 },
    });
    expect(built.enterprise.limits.pipelines).toBe(TIER_PRESETS.enterprise.limits.pipelines);
    expect(built.enterprise.limits.plugins).toBe(TIER_PRESETS.enterprise.limits.plugins);
    expect(built.enterprise.limits.apiCalls).toBe(123);
  });
});
