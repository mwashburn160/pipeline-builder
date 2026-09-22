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
  AppError, describeFindings, envBool, ErrorCode, exceedsVulnFloor, pluginVulnMaxCritical, SCAN_FLAG_TOP_FINDINGS,
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
  if (!exceedsVulnFloor(input.vulnCriticalFixable, max)) return null;
  const critical = input.vulnCriticalFixable ?? 0;
  const findings = topFixable(input.findings);
  return new AppError(422, ErrorCode.PLUGIN_VULN_GATE,
    `PLUGIN_VULN_GATE: the image has ${critical} fixable Critical finding${critical === 1 ? '' : 's'} (at most ${max} allowed). `
    + `Rebuild on patched packages: ${describeFindings(findings)}`,
    { critical, high: input.vulnHighFixable ?? 0, maxCritical: max, findings });
}

/** The rescan flag for a scan that breaks the floor, else null (clears an existing flag). */
export function scanFlagFor(input: FloorInput, max: number = pluginVulnMaxCritical()): PluginScanFlag | null {
  if (!exceedsVulnFloor(input.vulnCriticalFixable, max)) return null;
  return { critical: input.vulnCriticalFixable ?? 0, high: input.vulnHighFixable ?? 0, maxCritical: max, findings: topFixable(input.findings) };
}
