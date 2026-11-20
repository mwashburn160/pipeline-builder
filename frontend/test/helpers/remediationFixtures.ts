// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { PluginRemediationDto } from '../../src/types/plugin-remediation';

/** A propose-mode remediation waiting for approval: one finding cleared, two left for the owner. */
export const REMEDIATION: PluginRemediationDto = {
  id: 'rem-1', pluginId: 'p-1', pluginName: 'terraform-plan', fromVersion: '1.4.2', stage: 'awaiting_approval', outcome: null,
  toVersion: '1.4.3', toPluginId: 'p-2', versionBump: 'patch', upgradeLevel: 'minor', publishMode: 'propose',
  proposeReasons: ['org_mode', 'no_smoke_test'], fixMethods: ['rebuild', 'source_patch'], targetedCount: 3,
  cleared: [
    { id: 'CVE-2026-1', purl: 'pkg:deb/debian/openssl@3.0.1', packageName: 'openssl', packageType: 'deb', fromVersion: '3.0.1', toVersion: '3.0.2', method: 'rebuild' },
  ],
  remaining: [
    { id: 'CVE-2026-2', severity: 'critical', purl: 'pkg:golang/example.com/m@v1.0.0', packageName: 'example.com/m', packageType: 'go-module', packageVersion: 'v1.0.0', fixedIn: ['v2.0.0'], reason: 'go_module_major' },
    { id: 'CVE-2026-3', severity: 'high', purl: 'pkg:npm/lodash@4.0.0', packageName: 'lodash', packageType: 'npm', packageVersion: '4.0.0', fixedIn: ['5.0.0'], reason: 'beyond_upgrade_level', requiredLevel: 'major', kev: true },
  ],
  hasPatch: true, hasExport: false, rollout: null, rolledBackPipelineIds: [], error: null, attempt: 1, retryOf: null, decidedBy: null, decidedAt: null,
  createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T01:00:00Z', publishedAt: null, finishedAt: null,
};
