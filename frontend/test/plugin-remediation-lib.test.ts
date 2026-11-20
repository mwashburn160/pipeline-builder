// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from '@jest/globals';
import { PIPELINE_REMEDIATION_UPGRADE_STATES, PLUGIN_REMEDIATION_STAGES } from '@pipeline-builder/api-core/plugin-scan';
import {
  PIPELINE_UPGRADE_STATE_CATALOG, PIPELINE_UPGRADE_STATE_LABELS, REMEDIATION_STAGE_COLORS, REMEDIATION_STAGE_FILTERS, pipelineUpgradeState, findingRemediationMarker, lowestFixVersion, packageTypeLabel,
  remainingReasonLabel, remediationHref, shortLayer,
} from '../src/lib/plugin-remediation';

describe('plugin remediation copy', () => {
  it('colours every stage and filters on the four stages the plan names', () => {
    expect(Object.keys(REMEDIATION_STAGE_COLORS).sort()).toEqual([...PLUGIN_REMEDIATION_STAGES].sort());
    expect(REMEDIATION_STAGE_FILTERS.map((f) => f.key)).toEqual(['all', 'needs_owner', 'awaiting_approval', 'rolling_out', 'needs_review']);
  });

  it('marks a fix that crosses a major version, and one nothing can patch', () => {
    expect(findingRemediationMarker({ packageType: 'npm', packageVersion: '2.3.1', fixedIn: ['3.0.0'] }))
      .toEqual({ kind: 'major', requirement: 'major', fixVersion: '3.0.0' });
    // 0.x minors may break: counts as major.
    expect(findingRemediationMarker({ packageType: 'npm', packageVersion: '0.3.1', fixedIn: ['0.4.0'] })?.kind).toBe('major');
    // A Go /v2 module is always the owner's.
    expect(findingRemediationMarker({ packageType: 'go-module', packageVersion: 'v1.9.0', fixedIn: ['v2.0.1'] }))
      .toMatchObject({ kind: 'major', requirement: 'owner' });
    expect(findingRemediationMarker({ packageType: 'npm', packageVersion: '2.3.1', fixedIn: ['2.4.0', '2.3.4'] })).toBeNull();
    // A deb security revision of the same upstream is a patch.
    expect(findingRemediationMarker({ packageType: 'deb', packageVersion: '1.1.1n-0+deb11u5', fixedIn: ['1.1.1n-0+deb11u6'] })).toBeNull();
    expect(findingRemediationMarker({ packageType: 'deb', packageVersion: '1.0', fixedIn: [] })).toEqual({ kind: 'not_patchable', why: 'No fixed version yet' });
    expect(findingRemediationMarker({ packageType: 'conan', packageVersion: '1.0', fixedIn: ['1.0.1'] })?.kind).toBe('not_patchable');
  });

  it('picks the lowest fixed version by the package type ordering', () => {
    expect(lowestFixVersion(['2.10.0', '2.9.1'], 'npm')).toBe('2.9.1');
    expect(lowestFixVersion([], 'npm')).toBeNull();
  });

  it('words reasons, types and layers', () => {
    expect(remainingReasonLabel('beyond_upgrade_level', 'major')).toBe('Fix needs a bigger upgrade than allowed (needs a major upgrade)');
    expect(remainingReasonLabel('something_new')).toBe('something_new');
    expect(packageTypeLabel('deb')).toBe('Debian package');
    expect(packageTypeLabel(null)).toBe('Unknown');
    expect(packageTypeLabel('conan')).toBe('conan');
    expect(shortLayer('sha256:0123456789abcdef0123')).toBe('sha256:0123456789ab');
    expect(remediationHref('r 1')).toBe('/dashboard/plugins?tab=remediations&remediation=r%201');
  });

  it('catalogs every pipeline upgrade state once, and shows an unknown one as sent, in no section', () => {
    expect(Object.keys(PIPELINE_UPGRADE_STATE_CATALOG).sort()).toEqual([...PIPELINE_REMEDIATION_UPGRADE_STATES].sort());
    expect(PIPELINE_UPGRADE_STATE_LABELS.skipped_runner).toBe('Skipped (runner unhealthy)');
    expect(pipelineUpgradeState('skipped_runner')).toEqual({ label: 'Skipped (runner unhealthy)', color: 'gray', section: 'wave' });
    expect(pipelineUpgradeState('rollback_blocked').section).toBe('history');
    expect(pipelineUpgradeState('brand_new')).toEqual({ label: 'brand_new', color: 'gray', section: 'closed' });
  });
});
