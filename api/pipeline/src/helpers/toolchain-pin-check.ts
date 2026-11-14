// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline's toolchain release pin at SAVE time
 * (docs/plans/bootstrap-image-versioning.md §5, D15):
 *
 *   - a managed `cdk-synth` step can't carry its own version (or row id): the
 *     toolchain is pinned as one release with `toolchain.release` → 400
 *     TOOLCHAIN_PIN_VIA_RELEASE;
 *   - `toolchain.release` must name an ELIGIBLE release (live, and a former
 *     platform default or the org's canary) — but only when the pin CHANGES
 *     against the stored pipeline, so a pipeline whose pinned release was later
 *     yanked still saves unrelated edits → 400 TOOLCHAIN_RELEASE_NOT_ELIGIBLE.
 *
 * Existence at resolve time is the contract check's (it resolves the managed
 * step through the toolchain resolver with the same pin).
 */

import { ErrorCode, MANAGED_TOOLCHAIN, managedRefPinsVersion, managedToolchainRefName, toolchainReleasePin } from '@pipeline-builder/api-core';
import { isEligibleRelease } from '@pipeline-builder/pipeline-data';

/** A refused toolchain pin, in the write path's rejection shape. */
export interface ToolchainPinRejection {
  status: 400;
  code: ErrorCode.TOOLCHAIN_PIN_VIA_RELEASE | ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE;
  message: string;
  details: Record<string, unknown>;
}

/**
 * The plugin references of `props` (the synth step's and every stage step's),
 * labelled as pipeline-core's `collectPluginSteps` labels them. Walked here
 * rather than through pipeline-core: only the reference fields are read.
 */
function pluginRefs(props: unknown): Array<{ label: string; ref: { name?: unknown; alias?: unknown; filter?: unknown } }> {
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const p = rec(props);
  const out: Array<{ label: string; ref: Record<string, unknown> }> = [];
  const synth = rec(rec(p.synth).plugin);
  if (Object.keys(synth).length > 0) out.push({ label: 'synth', ref: synth });
  (Array.isArray(p.stages) ? p.stages : []).forEach((stage, i) => {
    const s = rec(stage);
    const stageName = typeof s.stageName === 'string' ? s.stageName : `stage ${i + 1}`;
    for (const step of Array.isArray(s.steps) ? s.steps : []) {
      const ref = rec(rec(step).plugin);
      const name = typeof ref.alias === 'string' ? ref.alias : String(ref.name ?? '');
      out.push({ label: `${stageName}/${name}`, ref });
    }
  });
  return out;
}

/** The managed `cdk-synth` steps of `props` that pin their own version (labels). */
export function stepsPinningManagedVersion(props: unknown): string[] {
  return pluginRefs(props)
    .filter(({ ref }) => managedToolchainRefName(ref) === MANAGED_TOOLCHAIN.synth && managedRefPinsVersion(ref.filter))
    .map(({ label }) => label);
}

/**
 * The toolchain-pin verdict for saving `props` over `storedProps` (absent on a
 * create). Null when it may be saved.
 */
export async function checkToolchainPin(props: unknown, orgId: string, storedProps?: unknown): Promise<ToolchainPinRejection | null> {
  const pinned = stepsPinningManagedVersion(props);
  if (pinned.length > 0) {
    return {
      status: 400,
      code: ErrorCode.TOOLCHAIN_PIN_VIA_RELEASE,
      message: `cdk-synth is part of the managed toolchain and can't be pinned on its own (${pinned.join(', ')}): remove filter.version and pin the whole release with toolchain.release.`,
      details: { steps: pinned },
    };
  }
  const release = toolchainReleasePin(props);
  if (release === undefined || release === toolchainReleasePin(storedProps)) return null;
  if (await isEligibleRelease(orgId, release)) return null;
  return {
    status: 400,
    code: ErrorCode.TOOLCHAIN_RELEASE_NOT_ELIGIBLE,
    message: `Toolchain release ${release} is not eligible: a pipeline can pin only a live release that has been the platform default or is in canary for your organization.`,
    details: { release },
  };
}
