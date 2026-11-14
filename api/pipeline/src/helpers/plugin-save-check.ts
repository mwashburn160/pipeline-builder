// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What a pipeline's plugin steps amount to at SAVE time, in the one shape every
 * write path answers with: the step problems that refuse the save (a contract
 * the pipeline doesn't meet, a reference that can't resolve — not installed,
 * denied by policy, unsigned; never vulnerability state), and the per-step
 * warnings a save that lands still carries (`pluginWarnings` on the create /
 * update / bulk / validate / instantiate responses).
 *
 * The refusals AND the warnings come from the contract check
 * (plugin-contract-check.ts), which resolves every step exactly as synth does —
 * one resolution per save, so a warning names the version the step will run.
 */

import type { VulnSeverity } from '@pipeline-builder/api-core';

import { checkPluginContracts, type StepContractViolation } from './plugin-contract-check.js';

/**
 * One note on a step. Vulnerability state NEVER refuses a save (or a synth, a
 * deploy, a run): a flagged, KEV or unscanned version is reported here, graded
 * by `severity`, with the version to move to when one is known.
 */
export interface PluginWarning {
  /** `synth` or `<stageName>/<alias ?? name>` — the step's label. */
  stepKey: string;
  plugin: string;
  /** `UNSCANNED`, `SCAN_STALE`, `VULN_FLAGGED`, `VULN_KEV`, `VULN_CRITICAL_FIXABLE`, `VULN_HIGH_FIXABLE`, `VULN_ACCEPTED`, `COMPLIANCE_VULN_RULE`, … */
  code: string;
  /** How serious it is (api-core's vulnerability grade) — graded, never a refusal. */
  severity: VulnSeverity;
  message: string;
  /** The newest version the step's pin allows that clears the finding, when known. */
  suggestedVersion?: string;
}

export interface PluginSaveCheck {
  /** Steps whose plugin can't resolve or whose contract the pipeline doesn't meet. */
  refusals: StepContractViolation[];
  warnings: PluginWarning[];
}

/**
 * The save-time plugin check for `props`: the contract check's refusals, and its
 * per-step vulnerability grades flattened to one warning per finding (the shared
 * assessment `/plugins/lookup` and `/plugins/runtime-check` run — never a
 * refusal). Pass `pipelineId` on an UPDATE so the pipeline's risk acceptances
 * downgrade what they accepted.
 */
export async function checkPipelinePlugins(props: unknown, orgId: string, parentOrgId?: string, pipelineId?: string): Promise<PluginSaveCheck> {
  const { violations, vulnerabilities } = await checkPluginContracts(props, orgId, parentOrgId, pipelineId ? { pipelineId } : {});
  return {
    refusals: violations,
    warnings: vulnerabilities.flatMap((step) => step.warnings.map((w) => ({
      stepKey: step.step,
      plugin: step.plugin,
      code: w.code,
      severity: w.severity,
      message: w.message,
      ...(w.suggestedVersion ? { suggestedVersion: w.suggestedVersion } : {}),
    }))),
  };
}
