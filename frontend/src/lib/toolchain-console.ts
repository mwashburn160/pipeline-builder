// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the system org's Toolchain console (docs/plans/
 * bootstrap-image-versioning.md §6, §8, §9, §11). No React, so each rule is
 * testable on its own. The server enforces every guard; these only explain.
 */
import { ApiError } from '@/lib/api/errors';
import { formatError } from '@/lib/constants';
import type {
  ToolchainCanaryGate, ToolchainConsoleRelease, ToolchainDefaultHistoryEntry, ToolchainDefaultPreview,
  ToolchainGateThresholds, ToolchainGuard,
} from '@/types/toolchain';

/** The console's route. */
export const TOOLCHAIN_CONSOLE_HREF = '/dashboard/toolchain';

/** §6 defaults (N runs, M orgs, T points), used until the server reports its own. */
export const DEFAULT_GATE_THRESHOLDS: ToolchainGateThresholds = { n: 20, m: 2, t: 5 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The §8 confirmation sentence: "N pipelines in M orgs follow the platform
 * default and will move on their next run; Q orgs have their own default and
 * P pipelines are pinned, so they won't move."
 */
export function platformBlastRadiusText(b: ToolchainDefaultPreview['blastRadius']): string {
  const moving = `${plural(b.followingPipelines, 'pipeline')} in ${plural(b.followingOrgs, 'org')} follow the platform default and will move on their next run`;
  const holds: string[] = [];
  if (b.orgsWithOwnDefault > 0) holds.push(`${plural(b.orgsWithOwnDefault, 'org')} ${b.orgsWithOwnDefault === 1 ? 'has its' : 'have their'} own default`);
  if (b.pinnedPipelines > 0) holds.push(`${plural(b.pinnedPipelines, 'pipeline')} ${b.pinnedPipelines === 1 ? 'is' : 'are'} pinned`);
  return holds.length === 0 ? `${moving}.` : `${moving}; ${holds.join(' and ')}, so they won't move.`;
}

/** A guard code without its `TOOLCHAIN_GUARD_` prefix, upper snake case. */
export function guardKey(code: string): string {
  return code.replace(/^TOOLCHAIN_GUARD_/i, '').replace(/[-\s]/g, '_').toUpperCase();
}

const GUARD_LABEL: Record<string, string> = {
  PAIR: 'Both halves present and live',
  PAIR_INCOMPLETE: 'Both halves present and live',
  SCAN: 'Both halves scanned',
  UNSCANNED: 'Both halves scanned',
  VULN_FLOOR: 'Within the fixable-Critical floor',
  METADATA: 'Toolchain metadata present',
  CANARY: 'Canary gate passed',
  CANARY_GATE: 'Canary gate passed',
};

/** A guard in words; an unknown code is shown as itself. */
export function guardLabel(code: string): string {
  return GUARD_LABEL[guardKey(code)] ?? code;
}

/** The canary gate is the one guard an operator may override (with a reason). */
export function isCanaryGuard(code: string): boolean {
  return guardKey(code).startsWith('CANARY');
}

/** Failed guards that no reason overrides. */
export function hardGuardFailures(guards: ToolchainGuard[]): ToolchainGuard[] {
  return guards.filter((g) => !g.ok && !isCanaryGuard(g.code));
}

/** Whether the preview says the canary gate stands in the way. */
export function canaryGuardFails(guards: ToolchainGuard[]): boolean {
  return guards.some((g) => !g.ok && isCanaryGuard(g.code));
}

/** A percent, or a dash when there is none yet. */
export function percentText(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v}%`;
}

export function sameThresholds(a: ToolchainGateThresholds, b: ToolchainGateThresholds): boolean {
  return a.n === b.n && a.m === b.m && a.t === b.t;
}

/** The gate's numbers, each against its threshold, one line each. */
export function gateLines(gate: ToolchainCanaryGate): string[] {
  const th = gate.thresholds;
  const base = gate.defaultFailureRate ?? 0;
  const over = gate.failureRate === null ? null : Math.round((gate.failureRate - base) * 100) / 100;
  return [
    `Synth runs: ${gate.runs} of ${th.n} required`,
    `Orgs: ${gate.orgs} of ${th.m} required`,
    `Failure rate: ${percentText(gate.failureRate)} vs the default's ${percentText(gate.defaultFailureRate)}`
      + (over === null ? ' (no runs yet)' : ` (${over} points over; at most ${th.t})`),
  ];
}

/**
 * The gate a refusal carries in `details.gate`. Accepts the console shape
 * (`runs`, `thresholds`) and the service's own (`countedRuns`, `params`).
 */
export function gateFromDetails(details: Record<string, unknown> | undefined): ToolchainCanaryGate | null {
  const g = details?.gate as Record<string, unknown> | undefined;
  if (!g || typeof g !== 'object') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const params = (g.thresholds ?? g.params) as Record<string, unknown> | undefined;
  return {
    passes: Boolean(g.passes ?? g.passed),
    runs: num(g.runs) ?? num(g.countedRuns) ?? 0,
    orgs: num(g.orgs) ?? 0,
    failureRate: num(g.failureRate),
    defaultFailureRate: num(g.defaultFailureRate) ?? num(g.baselineFailureRate),
    thresholds: {
      n: num(params?.n) ?? num(params?.minRuns) ?? DEFAULT_GATE_THRESHOLDS.n,
      m: num(params?.m) ?? num(params?.minOrgs) ?? DEFAULT_GATE_THRESHOLDS.m,
      t: num(params?.t) ?? num(params?.maxFailurePointsAboveDefault) ?? DEFAULT_GATE_THRESHOLDS.t,
    },
  };
}

/** How a "Set as platform default" refusal should be handled by the flow. */
export type SetDefaultRefusal =
  | { kind: 'changed'; currentDefault: string | null; message: string }
  | { kind: 'gate'; gate: ToolchainCanaryGate | null; message: string }
  | { kind: 'guard'; code: string; message: string }
  | { kind: 'other'; message: string };

export function classifySetDefaultError(err: unknown): SetDefaultRefusal {
  if (err instanceof ApiError && err.code) {
    if (err.code === 'TOOLCHAIN_DEFAULT_CHANGED') {
      const current = (err.details?.currentDefault ?? null) as string | null;
      return {
        kind: 'changed',
        currentDefault: current,
        message: `The platform default changed to ${current ?? 'none'} while you were reviewing. The preview below is refreshed; review it and confirm again.`,
      };
    }
    if (err.code === 'TOOLCHAIN_GUARD_CANARY_GATE') {
      return { kind: 'gate', gate: gateFromDetails(err.details), message: `${err.message} Give an override reason to promote anyway.` };
    }
    if (err.code.startsWith('TOOLCHAIN_GUARD_')) {
      return { kind: 'guard', code: err.code, message: `${guardLabel(err.code)}: refused. ${err.message}` };
    }
  }
  return { kind: 'other', message: formatError(err, 'Could not set the platform default') };
}

/** Actions the release row offers, by status (the server enforces each). */
export function releaseActionAvailability(r: Pick<ToolchainConsoleRelease, 'status' | 'complete'>) {
  const live = r.status !== 'yanked' && r.status !== 'deprecated';
  return {
    setDefault: live && r.status !== 'default' && r.complete,
    canary: live && r.status !== 'default',
    deprecate: live && r.status !== 'default',
    yank: r.status !== 'yanked',
    delete: r.status !== 'default',
  };
}

/** The release "Set previous as default" restores: the default before the current one. */
export function previousDefault(history: ToolchainDefaultHistoryEntry[], current: string | null): string | null {
  const latest = history[0];
  if (latest && latest.releaseVersion === current && latest.previousReleaseVersion) return latest.previousReleaseVersion;
  return history.find((h) => h.releaseVersion !== current)?.releaseVersion ?? null;
}
