// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The read-only MEASUREMENT of what superseded system plugin versions cost,
 * taken before anyone turns retention on (src/scripts/measure-superseded.ts
 * prints it). It is the dry run without the declared-resolution refresh (so it
 * writes nothing), summarised per plugin.
 */

import type { RetentionReport } from './plan.js';
import { runRetentionPass } from './retire.js';

/** The ordering rules: a version kept by one of these is INSIDE the newest N. */
const ORDERING_RULES = new Set(['newest_in_major', 'implicit_install', 'within_keep', 'prerelease_ahead_of_stable']);

export interface PluginMeasurement {
  name: string;
  listed: boolean;
  versions: number;
  /** Live versions the ordering rules alone would not keep. */
  outsideKeep: number;
  /** Of those, how many another rule holds, by rule. */
  holdouts: Record<string, number>;
  /** Of those, how many the pass would retire (deprecate, notice, yank). */
  retirable: number;
  /** Bytes the retirable versions would free; null when not measured. */
  marginalBytes: number | null;
  refusedReason?: string;
}

export interface Measurement {
  generatedAt: string;
  keep: number;
  plugins: PluginMeasurement[];
  totals: { versions: number; outsideKeep: number; retirable: number; marginalBytes: number | null; holdouts: Record<string, number> };
  storage: RetentionReport['storage'];
  /**
   * Manifests in `system/*` that no tag and no plugin row points at. Not
   * measured: the Distribution API lists tags, never untagged manifests, so
   * counting them needs a walk of the registry's storage backend.
   */
  orphanManifests: { measured: false; reason: string };
}

/** Summarise a dry-run report (pure). */
export function summarize(report: RetentionReport): Measurement {
  const totals = { versions: 0, outsideKeep: 0, retirable: 0, marginalBytes: report.storage.measured ? 0 : null as number | null, holdouts: {} as Record<string, number> };
  const plugins = report.plugins.map((p): PluginMeasurement => {
    const live = p.versions.filter((v) => v.rule !== 'already_yanked');
    const outside = live.filter((v) => !ORDERING_RULES.has(v.rule));
    const holdouts: Record<string, number> = {};
    let retirable = 0;
    for (const v of outside) {
      if (v.state === 'deprecate' || v.state === 'notice' || v.state === 'yank') {retirable++;} else if (v.state !== 'refused') {
        holdouts[v.rule] = (holdouts[v.rule] ?? 0) + 1;
        totals.holdouts[v.rule] = (totals.holdouts[v.rule] ?? 0) + 1;
      }
    }
    totals.versions += p.versions.length;
    totals.outsideKeep += outside.length;
    totals.retirable += retirable;
    if (totals.marginalBytes !== null && p.marginalBytes !== null) totals.marginalBytes += p.marginalBytes;
    return {
      name: p.name,
      listed: p.listed,
      versions: p.versions.length,
      outsideKeep: outside.length,
      holdouts,
      retirable,
      marginalBytes: p.marginalBytes,
      ...(p.refusedReason ? { refusedReason: p.refusedReason } : {}),
    };
  });
  return {
    generatedAt: report.generatedAt,
    keep: report.keep,
    plugins,
    totals,
    storage: report.storage,
    orphanManifests: { measured: false, reason: 'The registry API lists tags, not untagged manifests; counting orphans in system/* needs a walk of the storage backend.' },
  };
}

/** Measure now (read-only). */
export async function measureSuperseded(): Promise<Measurement> {
  return summarize(await runRetentionPass({ dryRun: true, refresh: false }));
}
