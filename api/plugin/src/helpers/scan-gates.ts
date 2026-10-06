// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's plugin image scan gates (docs/plugin-publishing.md "Scan
 * gates"), shared by every path that establishes a version's scan: the build
 * worker (upload, prebuilt, AI deploy, bulk, the catalog loader — all go
 * through it), the anonymous-submission quarantine gates, and the nightly
 * rescan's flag.
 *
 *  - UNSCANNED: a build whose image could not be scanned fails
 *    `IMAGE_SCAN_UNAVAILABLE` after its retries — unless the operator escape
 *    hatch `PLUGIN_ALLOW_UNSCANNED=true` persists it unscanned (audited
 *    `plugin.scan.skipped`).
 *  - FLOOR: more FIXABLE Critical findings than `PLUGIN_VULN_MAX_CRITICAL`
 *    (default 0, `-1` off) fails the build permanently `PLUGIN_VULN_GATE`, and
 *    flags an existing version on rescan. Org compliance rules can be stricter.
 */

import {
  AppError, applyVulnWaivers, describeFindings, envBool, ErrorCode, exceedsVulnFloor, pluginVulnMaxCritical, SCAN_FLAG_TOP_FINDINGS,
  type PluginScanFinding, type PluginScanFlag,
} from '@pipeline-builder/api-core';

type VulnFinding = PluginScanFinding;

/** The fixable findings (grype reports a fixed version), in their given order. */
export function fixableFindings(findings: readonly VulnFinding[]): VulnFinding[] {
  return findings.filter((f) => f.fixedIn.length > 0);
}

/** `PLUGIN_ALLOW_UNSCANNED` (default false): persist a version whose build-time scan could not run. */
export function allowUnscanned(): boolean {
  return envBool('PLUGIN_ALLOW_UNSCANNED', false);
}

/** The terminal build failure for an image that could not be scanned (nothing is persisted). */
export function scanUnavailableError(): AppError {
  return new AppError(422, ErrorCode.IMAGE_SCAN_UNAVAILABLE,
    'IMAGE_SCAN_UNAVAILABLE: image could not be scanned — the vulnerability scan did not run after every retry, so the version was not saved. '
    + 'Retry the build; if it keeps failing, the platform operator should check the vulnerability database.');
}

/** A scan's fixable counts plus its findings (what the floor reads). */
export interface FloorInput {
  vulnCriticalFixable: number | null;
  vulnHighFixable: number | null;
  findings: readonly VulnFinding[];
  /**
   * The plugin being gated. Required for `PLUGIN_VULN_WAIVERS` to apply — a
   * waiver is scoped to one plugin, so without the name there is nothing to
   * match and the floor is enforced unwaived. That is the safe direction: a
   * caller that forgets to pass it gets MORE enforcement, not less.
   */
  pluginName?: string;
  /** The version being gated; a version-pinned waiver covers only this one. */
  pluginVersion?: string;
  /**
   * The org the build belongs to. Also required, and for a sharper reason:
   * plugin names are unique per (name, version, orgId), not globally, so a
   * waiver matched on name alone would be inherited by any tenant who named
   * their plugin the same. Waivers apply to the system org only.
   */
  orgId?: string;
}

/**
 * Re-count the fixable Criticals with any unexpired waiver for this plugin
 * applied, and say what it removed.
 *
 * The recount is derived from the findings rather than trusting
 * `vulnCriticalFixable`: that number came from the scanner and knows nothing
 * about waivers, so subtracting from it would drift the moment the two
 * disagree. When there are no findings to count (an older scan recorded counts
 * only), the scanner's number stands and no waiver can apply.
 */
function waiveFloor(input: FloorInput): { critical: number; waived: VulnFinding[]; counted: readonly VulnFinding[] } {
  if (!input.pluginName || input.findings.length === 0) {
    return { critical: input.vulnCriticalFixable ?? 0, waived: [], counted: input.findings };
  }
  const { counted, waived } = applyVulnWaivers(input.pluginName, input.findings, undefined, undefined, input.orgId, input.pluginVersion);
  if (waived.length === 0) return { critical: input.vulnCriticalFixable ?? 0, waived: [], counted: input.findings };
  const critical = counted.filter((f) => f.severity === 'critical' && f.fixedIn.length > 0).length;
  return { critical, waived, counted };
}

/** What a waiver exempted on the last gate decision, for the caller to record. */
export function waivedFor(input: FloorInput): VulnFinding[] {
  return waiveFloor(input).waived;
}

/** The top fixable findings a message / flag carries, Criticals first. */
export function topFixable(findings: readonly VulnFinding[]): VulnFinding[] {
  return fixableFindings(findings).slice(0, SCAN_FLAG_TOP_FINDINGS);
}

/**
 * The permanent `PLUGIN_VULN_GATE` build failure when the scan breaks the
 * platform floor, else null. The message lists the top CVEs with their fixed
 * versions; `details` carries the counts and findings for the dashboard.
 */
export function vulnGateError(input: FloorInput, max: number = pluginVulnMaxCritical()): AppError | null {
  const { critical, waived, counted } = waiveFloor(input);
  if (!exceedsVulnFloor(critical, max)) return null;
  const findings = topFixable(counted);
  return new AppError(422, ErrorCode.PLUGIN_VULN_GATE,
    `PLUGIN_VULN_GATE: the image has ${critical} fixable Critical finding${critical === 1 ? '' : 's'} (at most ${max} allowed). `
    + `Rebuild on patched packages: ${describeFindings(findings)}`,
    // `waived` rides along so the failure record shows an exemption was in play
    // — a gate that still fails WITH a waiver active is a different situation
    // from one that never had one, and the operator should not have to guess.
    { critical, high: input.vulnHighFixable ?? 0, maxCritical: max, findings, waived: waived.length });
}

/** The rescan flag for a scan that breaks the floor, else null (clears an existing flag). */
export function scanFlagFor(input: FloorInput, max: number = pluginVulnMaxCritical()): PluginScanFlag | null {
  const { critical, counted } = waiveFloor(input);
  if (!exceedsVulnFloor(critical, max)) return null;
  return { critical, high: input.vulnHighFixable ?? 0, maxCritical: max, findings: topFixable(counted) };
}
