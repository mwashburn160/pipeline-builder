// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure halves of the vulnerability read models: the findings CSV (a file an
 * auditor opens in a spreadsheet, so a cell must never execute as a formula) and
 * (the scan-freshness rules live with the verdict in api-core's version-vuln-policy).
 */

import { jest, describe, it, expect } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';

jest.unstable_mockModule('../src/services/ecosystem/installs-store.js', () => ({ listingSource: { policiesForOrgs: async () => [] } }));
/** Every raw query, answered by `answer(sqlText)`; the org-row builder read answers `orgRows`. */
const queries: string[] = [];
let answer: (text: string) => Array<Record<string, unknown>> = () => [];
let orgRows: Array<Record<string, unknown>> = [];
let orgWhere: unknown[] = [];
const sqlText = (q: unknown): string => ((q as { queryChunks?: Array<{ value?: string[]; queryChunks?: unknown[] }> }).queryChunks ?? [])
  .map((c) => (Array.isArray(c.value) ? c.value.join('') : c && typeof c === 'object' && 'queryChunks' in c ? sqlText(c) : '?')).join('');
const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
const tx = {
  execute: async (q: unknown) => { const t = sqlText(q); queries.push(t); return { rows: answer(t) }; },
  select: () => ({ from: () => ({ where: (...w: unknown[]) => { orgWhere = w; return { limit: async () => orgRows }; } }) }),
};
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  withTenantTx: async (fn: (t: unknown) => unknown) => fn(tx),
  runWithTenantContext: (_c: unknown, fn: () => unknown) => fn(),
  executeRows: async (t: typeof tx, q: unknown) => (await t.execute(q)).rows,
  versionReferencedPredicate: actualData.versionReferencedPredicate,
  buildPluginConditions: () => [],
  withViewerContext: (f: unknown) => f,
  pipelinesOnVersion: async () => [],
  schema: actualData.schema,
}));

const { findingsCsv, fleetPosture, searchAdvisory } = await import('../src/services/plugin-vuln-posture.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('findingsCsv', () => {
  it('writes one row per finding with fixability, KEV and the waiver flag', () => {
    const csv = findingsCsv({
      plugin: { source: 'listing', id: 'v1', orgId: null, publisher: 'acme', name: 'scan', version: '1.0.0', imageDigest: DIGEST },
      summary: null,
      flagged: false,
      scanFlaggedAt: null,
      findings: [
        { id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2', '3.1.0'], kev: true, epss: 0.5, waived: false },
        { id: 'CVE-2', severity: 'high', packageName: 'zlib', packageVersion: '1.2', fixedIn: [], waived: true },
      ],
    });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('plugin,version,image_digest,advisory,severity,package,package_version,fixed_in,fixable,kev,epss,waived');
    expect(lines[1]).toBe(`acme/scan,1.0.0,${DIGEST},CVE-1,critical,openssl,3.0.1,3.0.2 3.1.0,true,true,0.5,false`);
    expect(lines[2]).toBe(`acme/scan,1.0.0,${DIGEST},CVE-2,high,zlib,1.2,,false,false,,true`);
  });

  it('neutralizes spreadsheet formulas and quotes separators', () => {
    const csv = findingsCsv({
      plugin: { source: 'org', id: 'p1', orgId: 'o', publisher: null, name: 'x', version: '1', imageDigest: null },
      summary: null,
      flagged: false,
      scanFlaggedAt: null,
      findings: [{ id: 'GHSA-1', severity: 'high', packageName: '=HYPERLINK("x")', packageVersion: '1,2', fixedIn: [], waived: false }],
    });
    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"1,2"');
  });
});

describe('withdrawn versions a pipeline still references', () => {
  it('counts them in the fleet posture (labelled) and asks the shared reference rule', async () => {
    queries.length = 0;
    answer = (t) => {
      if (t.includes('GROUP BY p.org_id')) return [{ org_id: 'org-a', versions: 3, critical: 2, withdrawn_referenced: 1 }];
      if (t.includes('LIMIT 20')) return [{ id: 'p1', org_id: 'org-a', name: 'lint', version: '1.0.0', state: 'deleted', scan_flagged_at: new Date(0), critical: 1, high: 0 }];
      if (t.includes('FROM plugin_listing_versions v') && t.includes('ORDER BY')) return [{ id: 'v1', publisher: 'acme', name: 'scan', version: '2.0.0', state: 'suspended', scan_flagged_at: new Date(1), critical: 1, high: 0 }];
      return [{ versions: 1, withdrawn_referenced: 1 }];
    };
    const out = await fleetPosture(new Date('2027-01-01T00:00:00Z'));
    expect(out.byOrg[0]).toEqual(expect.objectContaining({ orgId: 'org-a', withdrawnReferenced: 1 }));
    expect(out.listedVersions.withdrawnReferenced).toBe(1);
    expect(out.totals.withdrawnReferenced).toBe(2);
    expect(out.oldestFlagged.map((v) => [v.name, v.state])).toEqual([['lint', 'deleted'], ['scan', 'suspended']]);
    // Live versions, OR any version a pipeline references (declared / deployed / open exposure).
    const byOrg = queries.find((q) => q.includes('GROUP BY p.org_id'))!;
    expect(byOrg).toContain('p.deleted_at IS NULL AND p.is_active = true');
    expect(byOrg).toContain('pipeline_plugin_resolution');
    expect(byOrg).toContain('plugin_vuln_exposure');
  });

  it('finds a CVE in a deleted org row or a yanked / suspended listing version a pipeline still references, labelled with its state', async () => {
    queries.length = 0;
    orgRows = [{ id: 'p1', orgId: 'org-a', name: 'lint', version: '1.0.0', imageDigest: null, scannedAt: null, scanSummary: { findings: [{ id: 'CVE-9', severity: 'critical', packageName: 'x', packageVersion: '1', fixedIn: [], waived: false }] }, scanFlag: null, state: 'deleted' }];
    answer = () => [{ id: 'v1', org_id: null, publisher: 'acme', name: 'scan', version: '2.0.0', image_digest: 'sha256:d', scanned_at: null, scan_summary: { findings: [{ id: 'cve-9', severity: 'high', packageName: 'y', packageVersion: '1', fixedIn: [], waived: false }] }, scan_flag: null, state: 'yanked' }];
    const out = await searchAdvisory('CVE-9', 'org-a');
    expect(out.versions.map((v) => [v.source, v.name, v.state, v.findings.length])).toEqual([['org', 'lint', 'deleted', 1], ['listing', 'scan', 'yanked', 1]]);
    const listed = queries.find((q) => q.includes('FROM plugin_listing_versions v'))!;
    expect(listed).toContain("v.yanked_at IS NULL AND l.state IN ('listed', 'unmaintained')");
    expect(listed).toContain('pipeline_step_manifests');
    // The org-row read keeps deleted rows only when referenced (one OR condition).
    expect(orgWhere).toHaveLength(1);
  });
});
