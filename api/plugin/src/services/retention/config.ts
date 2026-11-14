// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The superseded-version retention pass's settings, read in ONE place so the
 * dry run, the scheduler and the on-demand run always agree.
 *
 * | Variable | Default | Meaning |
 * |---|---|---|
 * | `PLUGIN_RETENTION_ENABLED` | `false` | Run the daily pass. The dry run and the on-demand run work either way. |
 * | `PLUGIN_RETENTION_KEEP` | `3` (min 1) | Live versions kept per major, newest first by semver. |
 * | `PLUGIN_RETENTION_NOTICE_DAYS` | `30` (min 0) | Days a version stays deprecated before it is yanked. |
 * | `PLUGIN_RETENTION_BATCH` | `50` (min 1) | Versions acted on (deprecated or yanked) per pass. |
 * | `PLUGIN_RETENTION_MAX_FRACTION` | `0.5`, in (0, 1] | Per plugin per pass, at most this share of its live versions (at least one) is newly deprecated, oldest first; the rest wait for a later pass. |
 */

import { envBool, envInt, envStr } from '@pipeline-builder/api-core';

export interface RetentionConfig {
  enabled: boolean;
  keep: number;
  noticeDays: number;
  batch: number;
  maxFraction: number;
}

/** A share in (0, 1]; anything else (unset, unparseable, out of range) is the default. */
function fraction(name: string, def: number): number {
  const n = Number(envStr(name, String(def)).trim());
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : def;
}

/** The current settings (read per call, so a test or an operator override applies at once). */
export function retentionConfig(): RetentionConfig {
  return {
    enabled: envBool('PLUGIN_RETENTION_ENABLED', false),
    keep: envInt('PLUGIN_RETENTION_KEEP', 3, { min: 1 }),
    noticeDays: envInt('PLUGIN_RETENTION_NOTICE_DAYS', 30, { min: 0 }),
    batch: envInt('PLUGIN_RETENTION_BATCH', 50, { min: 1 }),
    maxFraction: fraction('PLUGIN_RETENTION_MAX_FRACTION', 0.5),
  };
}
