// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The scan finding a canary fixture's known advisory produces (remediation tests). */

import type { GrypePackageType, PluginScanFinding } from '@pipeline-builder/api-core';

import type { CanaryFixture } from '../../src/services/remediation/canary.js';

const PURL: Partial<Record<GrypePackageType, (f: CanaryFixture) => string>> = {
  'java-archive': (f) => `pkg:maven/com.fasterxml.jackson.core/${f.packageName}@${f.installed}`,
  'go-module': (f) => `pkg:golang/${f.packageName}@${f.installed}`,
};

export function fixtureFinding(f: CanaryFixture, over: Partial<PluginScanFinding> = {}): PluginScanFinding {
  return {
    id: f.advisory,
    severity: 'high',
    packageName: f.packageName,
    packageVersion: f.installed,
    fixedIn: [f.fixed],
    packageType: f.type,
    purl: PURL[f.type]?.(f) ?? `pkg:${f.type}/${f.packageName}@${f.installed}`,
    locations: [{ path: f.type === 'npm' ? `/app/node_modules/${f.packageName}/package.json` : f.type === 'python' ? `/usr/local/lib/python3.12/site-packages/${f.packageName}/__init__.py` : '/var/lib/pkg', layerID: 'sha256:layer-app' }],
    ...over,
  };
}

