// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin image scan gates (docs/plugin-publishing.md "Scan gates"): the shared
 * vocabulary of the build-time gate, the nightly rescan's flag, and the
 * resolution warning / block — used by the plugin service (which stores and
 * enforces them), the resolver in pipeline-data (which skips or warns), and the
 * dashboard (which shows them).
 *
 * A finding is FIXABLE when grype reports a fixed version for it
 * (`vulnerability.fix.state == "fixed"` with at least one version): the gates
 * count fixable Critical findings only, because an unfixable one can't be
 * acted on by rebuilding or upgrading.
 */

import { envBool, envInt } from '../utils/env.js';

/** One Critical/High finding as the flag and the gate messages carry it. */
export interface PluginScanFinding {
  /** The vulnerability id (CVE-…, GHSA-…). */
  id: string;
  severity: 'critical' | 'high';
  packageName: string;
  packageVersion: string;
  /** Versions that fix it; empty = no fix available (not fixable). */
  fixedIn: string[];
}

/**
 * `scan_flag` on a version the nightly rescan flagged: its fixable
 * Critical/High counts at that rescan and the top fixable findings. Set while
 * fixable Criticals exceed `PLUGIN_VULN_MAX_CRITICAL`, cleared when a rescan
 * finds them resolved.
 */
export interface PluginScanFlag {
  /** Fixable Critical findings. */
  critical: number;
  /** Fixable High findings. */
  high: number;
  /** The floor it was compared against (`PLUGIN_VULN_MAX_CRITICAL`). */
  maxCritical: number;
  /** At most {@link SCAN_FLAG_TOP_FINDINGS} fixable findings, Criticals first. */
  findings: PluginScanFinding[];
}

/** Findings a flag / gate message carries. */
export const SCAN_FLAG_TOP_FINDINGS = 10;

/** Lookup / resolution warning code for a flagged version. */
export const VULN_FLAGGED_WARNING = 'VULN_FLAGGED';

/**
 * `PLUGIN_VULN_MAX_CRITICAL`: the platform floor — a version with MORE fixable
 * Critical findings than this fails its build (`PLUGIN_VULN_GATE`) and is
 * flagged by the rescan. Default `0`; `-1` disables the floor (and the flag).
 */
export function pluginVulnMaxCritical(): number {
  return envInt('PLUGIN_VULN_MAX_CRITICAL', 0, { min: -1 });
}

/** Whether `fixableCritical` breaks the platform floor (never, when disabled). */
export function exceedsVulnFloor(fixableCritical: number | null | undefined, max: number = pluginVulnMaxCritical()): boolean {
  return max >= 0 && (fixableCritical ?? 0) > max;
}

/**
 * `PLUGIN_BLOCK_ON_NEW_CRITICAL` (default false): resolution SKIPS flagged
 * versions for ranges and the default (falling back to the newest unflagged
 * one), and an exact pin to a flagged version is refused 409
 * `PLUGIN_VERSION_VULN_BLOCKED`. Off: flagged versions resolve with a
 * `VULN_FLAGGED` warning.
 */
export function blockOnNewCritical(): boolean {
  return envBool('PLUGIN_BLOCK_ON_NEW_CRITICAL', false);
}

/** `pkg@1.2.3 → 1.2.4` / `pkg@1.2.3 (no fix)`. */
export function describeFix(f: Pick<PluginScanFinding, 'packageName' | 'packageVersion' | 'fixedIn'>): string {
  const at = `${f.packageName}${f.packageVersion ? `@${f.packageVersion}` : ''}`;
  return f.fixedIn.length > 0 ? `${at} → ${f.fixedIn.join(', ')}` : `${at} (no fix)`;
}

/** `CVE-1 (openssl@3.0.1 → 3.0.2); CVE-2 (…)` for the first `limit` findings. */
export function describeFindings(findings: readonly PluginScanFinding[], limit = 5): string {
  const shown = findings.slice(0, limit).map((f) => `${f.id} (${describeFix(f)})`).join('; ');
  const more = findings.length > limit ? `; +${findings.length - limit} more` : '';
  return `${shown}${more}`;
}

/** The warning text for a flagged version: `x@v has N fixable Critical findings — rebuild or upgrade`. */
export function vulnFlaggedMessage(ref: string, flag: Pick<PluginScanFlag, 'critical'>): string {
  return `${ref} has ${flag.critical} fixable Critical finding${flag.critical === 1 ? '' : 's'} — rebuild or upgrade`;
}

/** A `VULN_FLAGGED` lookup warning (the lookup envelope's `warnings[]` entry). */
export interface VulnFlaggedWarning {
  code: typeof VULN_FLAGGED_WARNING;
  plugin: string;
  version: string;
  critical: number;
  high: number;
  message: string;
  /** Top fixable findings with their fixed versions. */
  findings: PluginScanFinding[];
}

/** Build the `VULN_FLAGGED` warning for `plugin@version`. */
export function vulnFlaggedWarning(plugin: string, version: string, flag: PluginScanFlag): VulnFlaggedWarning {
  return {
    code: VULN_FLAGGED_WARNING,
    plugin,
    version,
    critical: flag.critical,
    high: flag.high,
    message: vulnFlaggedMessage(`${plugin}@${version}`, flag),
    findings: flag.findings.slice(0, SCAN_FLAG_TOP_FINDINGS),
  };
}

/** The 409 message for an exact pin to a flagged version while blocking. */
export function vulnBlockedMessage(plugin: string, version: string, flag: PluginScanFlag): string {
  const fixes = flag.findings.length > 0 ? ` Fix: ${describeFindings(flag.findings)}.` : '';
  return `${plugin}@${version} is blocked: a rescan found ${flag.critical} fixable Critical finding${flag.critical === 1 ? '' : 's'} `
    + `(PLUGIN_BLOCK_ON_NEW_CRITICAL). Rebuild it on patched packages or move to a newer version.${fixes}`;
}

/** Narrow an unknown `scan_flag` jsonb value. */
export function asScanFlag(value: unknown): PluginScanFlag | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.critical !== 'number' || typeof v.high !== 'number') return null;
  const findings = Array.isArray(v.findings) ? (v.findings as PluginScanFinding[]).filter((f) => f && typeof f.id === 'string') : [];
  return {
    critical: v.critical,
    high: v.high,
    maxCritical: typeof v.maxCritical === 'number' ? v.maxCritical : 0,
    findings: findings.map((f) => ({ ...f, fixedIn: Array.isArray(f.fixedIn) ? f.fixedIn : [] })),
  };
}
