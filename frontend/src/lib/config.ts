// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module lib/config
 * @description Build-time, client-safe configuration read from `NEXT_PUBLIC_*`
 * environment variables.
 *
 * Every value here is INLINED into the browser bundle at `next build`, so:
 *  - each read must stay a literal `process.env.NEXT_PUBLIC_X` expression
 *    (Next.js does not inline a dynamic `process.env[name]` lookup);
 *  - changing a value needs a rebuild, not a restart — the shipped image is
 *    shared across deployments, so these are effectively build defaults;
 *  - nothing secret belongs here.
 *
 * Server-only runtime settings live in `lib/server-config.ts`, which client
 * code must not import.
 */

/** A positive integer from `raw`, else `fallback` (unset, blank, non-numeric, zero or negative). */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  /**
   * Client-side abort for a plugin upload request, in ms
   * (`NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS`, default 5 minutes). An invalid value
   * falls back to the default rather than producing `NaN`, which `setTimeout`
   * treats as 0 and would abort every upload at once.
   */
  pluginBuildTimeoutMs: positiveInt(process.env.NEXT_PUBLIC_PLUGIN_BUILD_TIMEOUT_MS, 300_000),
} as const;
