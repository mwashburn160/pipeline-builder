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
 *  - FLOOR: more GATED findings than `PLUGIN_VULN_MAX_FINDINGS` (default 0,
 *    `-1` off) fails the build permanently `PLUGIN_VULN_GATE`, and flags an
 *    existing version on rescan. Gated = at or above `PLUGIN_VULN_FAIL_ON`
 *    (default `critical`; `high` adds High) AND either FIXABLE, or KEV-listed
 *    (CISA known exploited) with or without a fix under `PLUGIN_VULN_GATE_KEV`
 *    (default on). Org compliance rules can be stricter.
 */

import {
  AppError, applyVulnWaivers, describeFindings, envBool, ErrorCode, exceedsVulnFloor, failOnLabel, gatedFixableCount,
  isGatedFinding, pluginVulnFailOn, pluginVulnGateKev, pluginVulnMaxFindings, SCAN_FLAG_TOP_FINDINGS,
  type PluginScanFinding, type PluginScanFlag, type PluginVulnFailOn, type VulnWaiver,
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

/** What the floor decided about one scan, with any waiver applied. */
interface FloorDecision {
  /** Gated findings (at or above `failOn`) still counted after waivers. */
  gated: number;
  /** The `PLUGIN_VULN_FAIL_ON` this decision was made at. */
  failOn: PluginVulnFailOn;
  /** Of `gated`, the KEV-listed ones. */
  kev: number;
  waived: VulnFinding[];
  /** Waiver entries that exempted at least one finding. */
  matched: VulnWaiver[];
  counted: readonly VulnFinding[];
}

/**
 * Count the gated findings with any unexpired waiver for this plugin applied,
 * and say what it removed.
 *
 * The count is derived from the findings rather than trusting
 * the scanner's fixable counts: those know nothing about waivers or KEV, so
 * adjusting them would drift the moment the two disagree. When there are no
 * findings to count (an older scan recorded counts only), the scanner's
 * fixable count at or above the threshold stands and no waiver can apply.
 */
function decideFloor(input: FloorInput): FloorDecision {
  const failOn = pluginVulnFailOn();
  if (input.findings.length === 0) {
    return { gated: gatedFixableCount(input, failOn), failOn, kev: 0, waived: [], matched: [], counted: input.findings };
  }
  const kevGate = pluginVulnGateKev();
  const { counted, waived, matched } = input.pluginName
    ? applyVulnWaivers(input.pluginName, input.findings, undefined, undefined, input.orgId, input.pluginVersion)
    : { counted: [...input.findings], waived: [], matched: [] };
  const gated = counted.filter((f) => isGatedFinding(f, kevGate, failOn));
  return { gated: gated.length, failOn, kev: gated.filter((f) => f.kev === true).length, waived, matched, counted };
}

/** What a waiver exempted on the last gate decision, for the caller to record. */
export function waivedFor(input: FloorInput): VulnFinding[] {
  return decideFloor(input).waived;
}

/** The waiver ENTRIES that exempted something for this scan — the rescan's "is this waiver still used?" signal. */
export function matchedWaiversFor(input: FloorInput): VulnWaiver[] {
  return decideFloor(input).matched;
}

/**
 * The top findings a message / flag carries: what the floor gates on (fixable
 * Criticals, KEV-listed Criticals) and fixable Highs, Criticals and
 * known-exploited first.
 */
export function topFixable(findings: readonly VulnFinding[]): VulnFinding[] {
  const kevGate = pluginVulnGateKev();
  return findings.filter((f) => f.fixedIn.length > 0 || isGatedFinding(f, kevGate)).slice(0, SCAN_FLAG_TOP_FINDINGS);
}

/** `N fixable Critical findings` / `N Critical or High findings that are fixable or known exploited (M on CISA KEV)`. */
function gatedPhrase(gated: number, kev: number, failOn: PluginVulnFailOn): string {
  const s = gated === 1 ? '' : 's';
  const label = failOnLabel(failOn);
  return kev > 0
    ? `${gated} ${label} finding${s} that ${gated === 1 ? 'is' : 'are'} fixable or known exploited (${kev} on CISA KEV)`
    : `${gated} fixable ${label} finding${s}`;
}

/**
 * The permanent `PLUGIN_VULN_GATE` build failure when the scan breaks the
 * platform floor, else null. The message lists the top CVEs with their fixed
 * versions; `details` carries the counts and findings for the dashboard.
 */
export function vulnGateError(input: FloorInput, max: number = pluginVulnMaxFindings()): AppError | null {
  const { gated, failOn, kev, waived, counted } = decideFloor(input);
  if (!exceedsVulnFloor(gated, max)) return null;
  const findings = topFixable(counted);
  return new AppError(422, ErrorCode.PLUGIN_VULN_GATE,
    `PLUGIN_VULN_GATE: the image has ${gatedPhrase(gated, kev, failOn)} (at most ${max} allowed). `
    + `${kev > 0 ? `A known-exploited ${failOnLabel(failOn)} finding blocks even with no fix (PLUGIN_VULN_GATE_KEV). ` : ''}`
    + `Rebuild on patched packages: ${describeFindings(findings)}`,
    // `waived` rides along so the failure record shows an exemption was in play
    // — a gate that still fails WITH a waiver active is a different situation
    // from one that never had one, and the operator should not have to guess.
    { gated, high: input.vulnHighFixable ?? 0, maxFindings: max, failOn, findings, waived: waived.length, ...(kev > 0 ? { kev } : {}) });
}

/** The rescan flag for a scan that breaks the floor, else null (clears an existing flag). */
export function scanFlagFor(input: FloorInput, max: number = pluginVulnMaxFindings()): PluginScanFlag | null {
  const { gated, failOn, kev, counted } = decideFloor(input);
  if (!exceedsVulnFloor(gated, max)) return null;
  const extra = { ...(failOn === 'high' ? { failOn } : {}), ...(kev > 0 ? { kev } : {}) };
  return { gated, high: input.vulnHighFixable ?? 0, maxFindings: max, ...extra, findings: topFixable(counted) };
}
