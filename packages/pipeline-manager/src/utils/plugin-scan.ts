// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The local SCAN PREVIEW before `plugin publish`: syft builds an SBOM of the
 * plugin image, grype scans that SBOM — the same pair the platform runs over
 * the signed SBOM after upload. A critical finding fails the publish gate
 * there, so it fails here first.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasTool, type Exec } from './plugin-docker.js';

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'] as const;
export type SeverityCounts = Record<typeof SEVERITIES[number], number>;

export type ScanPreview =
  | { status: 'scanned'; counts: SeverityCounts; critical: string[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

/** Count grype JSON matches by severity; list the critical ones (`CVE in package@version`). */
export function summarizeGrype(json: string): { counts: SeverityCounts; critical: string[] } {
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0])) as SeverityCounts;
  const critical: string[] = [];
  const doc = JSON.parse(json) as { matches?: Array<{ vulnerability?: { id?: string; severity?: string }; artifact?: { name?: string; version?: string } }> };
  for (const m of doc.matches ?? []) {
    const sev = (SEVERITIES as readonly string[]).includes(m.vulnerability?.severity ?? '') ? m.vulnerability!.severity as typeof SEVERITIES[number] : 'Unknown';
    counts[sev] += 1;
    if (sev === 'Critical') critical.push(`${m.vulnerability?.id ?? '?'} in ${m.artifact?.name ?? '?'}@${m.artifact?.version ?? '?'}`);
  }
  return { counts, critical };
}

/** SBOM (syft) + scan (grype) of a local image. Never throws. */
export function scanPreview(exec: Exec, image: string): ScanPreview {
  const missing = ['syft', 'grype'].filter(t => !hasTool(exec, t, ['version']));
  if (missing.length) return { status: 'unavailable', reason: `${missing.join(' and ')} not installed` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-manager-scan-'));
  try {
    const sbom = path.join(dir, 'sbom.spdx.json');
    const s = exec('syft', ['scan', `docker:${image}`, '-o', `spdx-json=${sbom}`, '-q']);
    if (s.error || s.status !== 0) return { status: 'failed', reason: `syft could not build the SBOM: ${(s.stderr || s.error?.message || '').trim()}` };
    const g = exec('grype', [`sbom:${sbom}`, '-o', 'json', '-q']);
    if (g.error || g.status !== 0) return { status: 'failed', reason: `grype could not scan the SBOM: ${(g.stderr || g.error?.message || '').trim()}` };
    try {
      return { status: 'scanned', ...summarizeGrype(g.stdout) };
    } catch {
      return { status: 'failed', reason: 'grype output was not JSON' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
