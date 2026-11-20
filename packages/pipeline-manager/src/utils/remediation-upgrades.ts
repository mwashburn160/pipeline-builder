// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's "plugin security fixes" election (nightly plugin CVE
 * remediation, docs/plugin-installing.md) from the CLI: the
 * `remediationUpgrades` field of a pipeline definition and the
 * `--remediation-upgrades` flag.
 *
 * It is a PLATFORM setting (the pipelines.remediation_upgrades column), never a
 * synth prop: it is lifted out of the definition before the props are sent or
 * synthesized, so it cannot change what CDK builds. The flag wins over the file;
 * when neither sets it nothing is sent and the stored value (e.g. set in the
 * dashboard) stands.
 */

import { PIPELINE_REMEDIATION_ELECTIONS, type PipelineRemediationElection } from '@pipeline-builder/api-core';
import { ValidationError } from './error-handler.js';

/** The definition field (and request body field) name. */
export const REMEDIATION_UPGRADES_FIELD = 'remediationUpgrades';

/** The server's refusal code for an `apply` the org does not allow. */
export const REMEDIATION_APPLY_REFUSED_CODE = 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED';

/** What to do about that refusal, from the CLI. */
export const REMEDIATION_APPLY_REFUSED_HINT =
  'Your organization does not let pipelines choose apply for plugin security fixes. '
  + 'Use --remediation-upgrades inherit, off or propose (or change "remediationUpgrades" in the pipeline definition), '
  + 'or ask a root-org admin to allow pipelines to choose Apply in the plugin security fixes settings.';

/** Validate an election against the catalog; `source` names where it came from. */
export function parseRemediationUpgrades(value: unknown, source: string): PipelineRemediationElection {
  if (typeof value === 'string' && (PIPELINE_REMEDIATION_ELECTIONS as readonly string[]).includes(value)) {
    return value as PipelineRemediationElection;
  }
  throw new ValidationError(
    `${source} must be one of ${PIPELINE_REMEDIATION_ELECTIONS.join(', ')} (got ${JSON.stringify(value)})`,
    REMEDIATION_UPGRADES_FIELD,
    value,
    undefined,
    PIPELINE_REMEDIATION_ELECTIONS.join('|'),
  );
}

/**
 * Split a definition into the props synth reads and its election (validated).
 * The props are the definition WITHOUT the field, so a definition that sets it
 * synthesizes exactly like one that does not.
 */
export function liftRemediationUpgrades(definition: Record<string, unknown>): {
  props: Record<string, unknown>;
  remediationUpgrades: PipelineRemediationElection | undefined;
} {
  if (!Object.prototype.hasOwnProperty.call(definition, REMEDIATION_UPGRADES_FIELD)) {
    return { props: definition, remediationUpgrades: undefined };
  }
  const { [REMEDIATION_UPGRADES_FIELD]: raw, ...props } = definition;
  return { props, remediationUpgrades: parseRemediationUpgrades(raw, `"${REMEDIATION_UPGRADES_FIELD}" in the pipeline definition`) };
}

/** The election a write sends: the flag over the definition; undefined → send nothing. */
export function resolveRemediationUpgrades(
  flag: string | undefined,
  fromDefinition: PipelineRemediationElection | undefined,
): PipelineRemediationElection | undefined {
  if (flag !== undefined) return parseRemediationUpgrades(flag, '--remediation-upgrades');
  return fromDefinition;
}

/** The `--remediation-upgrades` help text, shared by the commands that write a pipeline. */
export const REMEDIATION_UPGRADES_OPTION_HELP =
  `Plugin security fixes election for this pipeline (${PIPELINE_REMEDIATION_ELECTIONS.join('|')}): `
  + 'inherit follows the organization, off opts out, propose opens proposals, apply moves the pipeline onto fixed plugin versions '
  + '(only when the organization allows it). Overrides "remediationUpgrades" in the definition; omitted, the stored value is kept.';

/** Whether a response body is the server's apply refusal. */
export function isRemediationApplyRefused(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { code?: unknown }).code === REMEDIATION_APPLY_REFUSED_CODE;
}
