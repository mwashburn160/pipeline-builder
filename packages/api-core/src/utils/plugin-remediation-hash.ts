// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { remediationFindingsKey } from '../types/plugin-remediation.js';
import type { PluginScanFinding } from '../types/plugin-scan.js';

/**
 * `plugin_remediations.findings_hash`: sha256 (hex) of the canonical text of
 * the targeted findings ({@link remediationFindingsKey}). Order-insensitive and
 * duplicate-insensitive; changes when a finding's fixed versions change.
 * Node-only (kept out of the browser-loaded types module).
 */
export function remediationFindingsHash(findings: ReadonlyArray<Pick<PluginScanFinding, 'id' | 'purl' | 'packageVersion' | 'fixedIn'>>): string {
  return createHash('sha256').update(remediationFindingsKey(findings)).digest('hex');
}
