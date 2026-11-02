// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/vuln-scan: grype invocation over the signed SBOM,
 * report parsing and severity counting, fail-closed error paths, the
 * serialized vulnerability-DB refresh, and `crane config` USER inspection.
 * Child processes are mocked at `build-process.run`.
 */

import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockRun = jest.fn<(...a: any[]) => Promise<string>>();
const mockFetchImageSbom = jest.fn<(...a: any[]) => Promise<Record<string, unknown>>>();
const mockWriteAuthConfig = jest.fn<(...a: any[]) => string>();
const mockIncCounter = jest.fn();
const mockObserve = jest.fn();
const mockSetGauge = jest.fn();

jest.unstable_mockModule('../src/helpers/build-process.js', () => ({ run: mockRun }));
jest.unstable_mockModule('../src/helpers/docker-build.js', () => ({ PUBLISH_PLATFORM: 'linux/amd64' }));
jest.unstable_mockModule('../src/helpers/registry-auth.js', () => ({
  imageRepository: (name: string, reg: { host: string; port: number }, orgId?: string) => `${reg.host}:${reg.port}/org-${orgId}/${name}`,
  writeAuthConfig: mockWriteAuthConfig,
}));
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({
  DIGEST_RE: /^sha256:[0-9a-f]{64}$/,
  fetchImageSbom: mockFetchImageSbom,
}));
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter, observe: mockObserve, setGauge: mockSetGauge }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ pushTimeoutMs: 30_000 }) },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const vs = await import('../src/helpers/vuln-scan.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = { orgId: 'org-1', name: 'trivy', imageDigest: DIGEST };
const REGISTRY = { host: 'registry', port: 5000, network: '', http: true };

const match = (id: string, severity: string, name = 'openssl', version = '1.0', fix?: { state: string; versions: unknown[] }) => ({
  vulnerability: { id, severity, ...(fix ? { fix } : {}) },
  artifact: { name, version },
});
const report = (...matches: unknown[]) => JSON.stringify({ matches });

beforeEach(() => {
  jest.clearAllMocks();
  vs._resetVulnDbState();
  delete process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE;
  delete process.env.PLUGIN_VULN_DB_MAX_AGE_HOURS;
  delete process.env.PLUGIN_VULN_VEX_DIR;
});

describe('parseGrypeReport', () => {
  it('counts each severity and itemizes only critical/high findings', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Critical'),
      match('CVE-2', 'High', 'curl', '8.0'),
      match('CVE-3', 'Medium'),
      match('CVE-4', 'Low'),
      match('CVE-5', 'low', 'zlib'),
    ));
    expect(r).toMatchObject({ critical: 1, high: 1, medium: 1, low: 2, criticalFixable: 0, highFixable: 0 });
    expect(r.findings).toEqual([
      { id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '1.0', fixedIn: [] },
      { id: 'CVE-2', severity: 'high', packageName: 'curl', packageVersion: '8.0', fixedIn: [] },
    ]);
  });

  it('counts a critical/high as FIXABLE only when grype reports fix.state "fixed" with a version', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Critical', 'openssl', '1.0', { state: 'fixed', versions: ['1.1', ' 1.1 ', ''] }),
      match('CVE-2', 'Critical', 'zlib', '1.0', { state: 'not-fixed', versions: [] }),
      match('CVE-3', 'Critical', 'curl', '8.0', { state: 'wont-fix', versions: ['9.0'] }),
      match('CVE-4', 'High', 'curl', '8.0', { state: 'Fixed', versions: ['8.1'] }),
      match('CVE-5', 'High', 'libxml', '2.0', { state: 'fixed', versions: [] }),
      match('CVE-6', 'Medium', 'libxml', '2.0', { state: 'fixed', versions: ['2.1'] }),
    ));
    expect(r).toMatchObject({ critical: 3, high: 2, medium: 1, criticalFixable: 1, highFixable: 1 });
    // Criticals first, fixable before unfixable.
    expect(r.findings.map((f) => [f.id, f.fixedIn])).toEqual([
      ['CVE-1', ['1.1']], ['CVE-2', []], ['CVE-3', []], ['CVE-4', ['8.1']], ['CVE-5', []],
    ]);
  });

  it('a later matcher of the same finding that knows the fix makes it fixable (once)', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Critical'),
      match('CVE-1', 'Critical', 'openssl', '1.0', { state: 'fixed', versions: ['1.1'] }),
      match('CVE-1', 'Critical', 'openssl', '1.0', { state: 'fixed', versions: ['1.2'] }),
    ));
    expect(r).toMatchObject({ critical: 1, criticalFixable: 1 });
    expect(r.findings).toEqual([{ id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '1.0', fixedIn: ['1.1'] }]);
  });

  it('counts one (vulnerability, package, version) once, however many matchers report it', () => {
    const r = vs.parseGrypeReport(report(match('CVE-1', 'High'), match('CVE-1', 'High'), match('CVE-1', 'High', 'openssl', '1.1')));
    expect(r.high).toBe(2);
    expect(r.findings).toHaveLength(2);
  });

  it('ignores Negligible / Unknown severities and malformed matches', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Negligible'),
      match('CVE-2', 'Unknown'),
      { vulnerability: { severity: 'High' } }, // no id
      { vulnerability: { id: 'CVE-3', severity: 7 } },
      null,
      { vulnerability: { id: 'CVE-4', severity: 'High' }, artifact: { name: 5 } },
    ));
    expect(r).toMatchObject({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(r.findings).toEqual([{ id: 'CVE-4', severity: 'high', packageName: '', packageVersion: '', fixedIn: [] }]);
  });

  it('reads CISA KEV and EPSS from the primary record AND its related ones, and ranks known-exploited first', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Critical', 'openssl', '1.0', { state: 'fixed', versions: ['1.1'] }),
      // GHSA-primary: the KEV entry and EPSS score ride the related CVE record.
      {
        vulnerability: { id: 'GHSA-aaaa-bbbb-cccc', severity: 'Critical', epss: [{ cve: 'CVE-2', epss: 0.12, percentile: 0.9 }] },
        relatedVulnerabilities: [{ id: 'CVE-2', knownExploited: [{ cve: 'CVE-2', dateAdded: '2026-10-01' }], epss: [{ cve: 'CVE-2', epss: 0.97 }] }],
        artifact: { name: 'lodash', version: '4.0.0' },
      },
      { ...match('CVE-3', 'High'), vulnerability: { id: 'CVE-3', severity: 'High', knownExploited: [] } },
    ));
    expect(r.findings).toEqual([
      { id: 'GHSA-aaaa-bbbb-cccc', severity: 'critical', packageName: 'lodash', packageVersion: '4.0.0', fixedIn: [], kev: true, epss: 0.97 },
      { id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '1.0', fixedIn: ['1.1'] },
      // An empty knownExploited list is not a listing; no score → no epss field.
      { id: 'CVE-3', severity: 'high', packageName: 'openssl', packageVersion: '1.0', fixedIn: [] },
    ]);
  });

  it('a later matcher of the same finding can add the KEV listing', () => {
    const r = vs.parseGrypeReport(report(
      match('CVE-1', 'Critical'),
      { vulnerability: { id: 'CVE-1', severity: 'Critical', knownExploited: [{ cve: 'CVE-1' }] }, artifact: { name: 'openssl', version: '1.0' } },
    ));
    expect(r.findings).toEqual([{ id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '1.0', fixedIn: [], kev: true }]);
  });

  it('a clean report is all zeros', () => {
    expect(vs.parseGrypeReport(report())).toEqual({ critical: 0, high: 0, medium: 0, low: 0, criticalFixable: 0, highFixable: 0, findings: [] });
  });

  it('throws on anything that is not a grype report (never a clean result)', () => {
    expect(() => vs.parseGrypeReport('not json')).toThrow(/not JSON/);
    expect(() => vs.parseGrypeReport('{}')).toThrow(/no matches array/);
    expect(() => vs.parseGrypeReport('null')).toThrow(/no matches array/);
    expect(() => vs.parseGrypeReport('{"matches":{}}')).toThrow(/no matches array/);
  });
});

describe('uncataloguedBinaries — executables no SBOM package owns', () => {
  // The shape syft 1.55 writes (verified on hadolint, ubuntu:26.10 and k6).
  const sbom = {
    packages: [{ SPDXID: 'SPDXRef-Package-go-module-stdlib-1', name: 'stdlib' }, { SPDXID: 'SPDXRef-Package-deb-coreutils-2', name: 'coreutils' }],
    files: [
      { fileName: 'usr/local/bin/crane', SPDXID: 'SPDXRef-File-crane' },
      { fileName: 'bin/ls', SPDXID: 'SPDXRef-File-ls' },
      { fileName: 'bin/hadolint', SPDXID: 'SPDXRef-File-hadolint' },
      { fileName: '/opt/app/snyk', SPDXID: 'SPDXRef-File-snyk' },
      { fileName: 'srv/cache/bundle.tar.gz', SPDXID: 'SPDXRef-File-archive' },
      { fileName: '', SPDXID: 'SPDXRef-File-empty' },
    ],
    relationships: [
      // A Go binary's modules are "evident by" it; a dpkg file is CONTAINED by its package.
      { spdxElementId: 'SPDXRef-Package-go-module-stdlib-1', relatedSpdxElement: 'SPDXRef-File-crane', relationshipType: 'OTHER' },
      { spdxElementId: 'SPDXRef-Package-deb-coreutils-2', relatedSpdxElement: 'SPDXRef-File-ls', relationshipType: 'CONTAINS' },
      { spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: 'SPDXRef-DocumentRoot-Image-x', relationshipType: 'DESCRIBES' },
    ],
  };

  it('lists the executables with no package relationship, absolute and sorted; archives are not binaries', () => {
    expect(vs.uncataloguedBinaries(sbom)).toEqual(['/bin/hadolint', '/opt/app/snyk']);
  });

  it('is empty for a fully catalogued image and for an SBOM with no files', () => {
    expect(vs.uncataloguedBinaries({ ...sbom, files: sbom.files.slice(0, 2) })).toEqual([]);
    expect(vs.uncataloguedBinaries({})).toEqual([]);
  });

  it('is capped', () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ fileName: `bin/b${String(i).padStart(3, '0')}`, SPDXID: `SPDXRef-File-${i}` }));
    expect(vs.uncataloguedBinaries({ files })).toHaveLength(200);
  });
});

describe('vulnerability DB age', () => {
  const status = (built: string | undefined, valid = true) => JSON.stringify({ schemaVersion: 'v6.1.3', built, path: '/db/6/vulnerability.db', valid });

  it('reads the DB build time from `grype db status -o json` and exports it as a gauge', async () => {
    mockRun.mockResolvedValue(status('2026-11-01T06:12:44Z'));
    await expect(vs.vulnDbBuiltAt()).resolves.toEqual(new Date('2026-11-01T06:12:44Z'));
    expect(mockRun).toHaveBeenCalledWith('grype', ['db', 'status', '-o', 'json'], 30_000, expect.objectContaining({ GRYPE_DB_CACHE_DIR: expect.any(String) }), { captureStdout: true });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_db_built_timestamp_seconds', {}, Date.parse('2026-11-01T06:12:44Z') / 1000);
  });

  it('is null — never a guess — for a missing / invalid DB or an unreadable status', async () => {
    mockRun.mockRejectedValueOnce(new Error('grype exited 1: database does not exist'));
    await expect(vs.vulnDbBuiltAt()).resolves.toBeNull();
    mockRun.mockResolvedValueOnce(status('2026-11-01T06:12:44Z', false));
    await expect(vs.vulnDbBuiltAt()).resolves.toBeNull();
    mockRun.mockResolvedValueOnce(status('not a date'));
    await expect(vs.vulnDbBuiltAt()).resolves.toBeNull();
    expect(mockSetGauge).not.toHaveBeenCalled();
  });

  it('assertVulnDbFresh refuses a DB older than PLUGIN_VULN_DB_MAX_AGE_HOURS (default 36), or an unknown one', async () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    mockRun.mockResolvedValue(status('2026-11-01T06:00:00Z')); // 30h
    await expect(vs.assertVulnDbFresh(now)).resolves.toEqual(new Date('2026-11-01T06:00:00Z'));
    mockRun.mockResolvedValue(status('2026-10-31T12:00:00Z')); // 48h
    await expect(vs.assertVulnDbFresh(now)).rejects.toBeInstanceOf(vs.VulnDbStaleError);
    process.env.PLUGIN_VULN_DB_MAX_AGE_HOURS = '72';
    await expect(vs.assertVulnDbFresh(now)).resolves.toBeInstanceOf(Date);
    mockRun.mockRejectedValue(new Error('no db'));
    await expect(vs.assertVulnDbFresh(now)).rejects.toThrow(/unreadable/);
  });

  it('REGRESSION: the age check applies with auto-update OFF (EKS: an operator CronJob owns the DB)', async () => {
    process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE = 'false';
    mockRun.mockResolvedValue(status('2026-10-20T00:00:00Z'));
    await vs.refreshVulnDb({ force: true }); // a no-op…
    await expect(vs.assertVulnDbFresh(Date.parse('2026-11-02T00:00:00Z'))).rejects.toBeInstanceOf(vs.VulnDbStaleError); // …the age check is not
  });
});

describe('vexArgs — operator OpenVEX', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-vex-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('passes every *.json document as --vex, sorted, and counts them', () => {
    for (const f of ['b.json', 'a.JSON', 'notes.md']) fs.writeFileSync(path.join(dir, f), '{}');
    expect(vs.vexArgs(dir)).toEqual(['--vex', path.join(dir, 'a.JSON'), '--vex', path.join(dir, 'b.json')]);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_vex_documents', {}, 2);
  });

  it('none when unset; an unreadable directory scans WITHOUT VEX (VEX only ever suppresses)', () => {
    expect(vs.vexArgs(undefined)).toEqual([]);
    expect(vs.vexArgs(path.join(dir, 'missing'))).toEqual([]);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_vex_documents', {}, 0);
  });

  it('scanSbom hands the documents to grype', async () => {
    fs.writeFileSync(path.join(dir, 'acme.json'), '{}');
    process.env.PLUGIN_VULN_VEX_DIR = dir;
    mockRun.mockResolvedValue(report());
    await vs.scanSbom({}, 'build');
    expect(mockRun.mock.calls[0]![1].slice(-2)).toEqual(['--vex', path.join(dir, 'acme.json')]);
  });
});

describe('scanSummary', () => {
  const scan = (findings: any[], over: Record<string, unknown> = {}) => ({
    critical: 2,
    high: 1,
    medium: 3,
    low: 4,
    criticalFixable: 1,
    highFixable: 0,
    scannedAt: new Date('2026-11-02T00:00:00Z'),
    dbBuiltAt: new Date('2026-11-01T06:00:00Z'),
    findings,
    ...over,
  });
  const f = (id: string, severity: 'critical' | 'high' = 'critical', extra: Record<string, unknown> = {}) =>
    ({ id, severity, packageName: 'openssl', packageVersion: '1.0', fixedIn: [], ...extra });

  it('carries every count, all critical/high findings (fixable or not), the waived keys, the DB and the opaque binaries', () => {
    const findings = [f('CVE-1', 'critical', { kev: true }), f('CVE-2', 'critical', { fixedIn: ['1.1'] }), f('CVE-3', 'high')];
    expect(vs.scanSummary(scan(findings), { imageDigest: DIGEST, trigger: 'rescan', waived: [findings[1]!], uncataloguedBinaries: ['/bin/hadolint'] })).toEqual({
      criticalFixable: 1,
      highFixable: 0,
      critical: 2,
      high: 1,
      medium: 3,
      low: 4,
      kev: 1,
      findings,
      truncated: false,
      waived: ['CVE-2|openssl|1.0'],
      scannedAt: '2026-11-02T00:00:00.000Z',
      trigger: 'rescan',
      imageDigest: DIGEST,
      dbBuiltAt: '2026-11-01T06:00:00.000Z',
      uncataloguedBinaries: ['/bin/hadolint'],
    });
  });

  it('caps the itemized findings (never the counts) and says so', () => {
    const findings = Array.from({ length: 501 }, (_, i) => f(`CVE-${i}`, 'high'));
    const s = vs.scanSummary(scan(findings, { high: 501 }), { imageDigest: DIGEST, trigger: 'build', waived: [], uncataloguedBinaries: null });
    expect(s).toMatchObject({ high: 501, truncated: true, uncataloguedBinaries: [], dbBuiltAt: '2026-11-01T06:00:00.000Z' });
    expect(s.findings).toHaveLength(500);
  });
});

describe('sbomPackageNames / isRootUser / scanColumns', () => {
  it('dedupes and sorts package names, dropping the document root', () => {
    expect(vs.sbomPackageNames({
      packages: [
        { SPDXID: 'SPDXRef-DocumentRoot-Image-x', name: 'the-image' },
        { SPDXID: 'SPDXRef-Package-1', name: 'zlib' },
        { SPDXID: 'SPDXRef-Package-2', name: 'openssl' },
        { SPDXID: 'SPDXRef-Package-3', name: 'zlib' },
        { name: '' },
        null,
      ],
    })).toEqual(['openssl', 'zlib']);
    expect(vs.sbomPackageNames({})).toEqual([]);
  });

  it.each([
    [undefined, true], ['', true], ['0', true], ['root', true], ['0:0', true], [' root:wheel ', true],
    ['app', false], ['1000', false], ['1000:0', false],
  ])('isRootUser(%p) = %p', (user, expected) => {
    expect(vs.isRootUser(user)).toBe(expected);
  });

  it('maps a scan to columns, and an unscanned result to all NULL', () => {
    const at = new Date();
    expect(vs.scanColumns({ critical: 1, high: 2, medium: 3, low: 4, criticalFixable: 1, highFixable: 0, scannedAt: at, findings: [], dbBuiltAt: null }))
      .toEqual({ vulnCritical: 1, vulnHigh: 2, vulnMedium: 3, vulnLow: 4, vulnCriticalFixable: 1, vulnHighFixable: 0, scannedAt: at });
    expect(vs.scanColumns(null)).toEqual({ vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, vulnCriticalFixable: null, vulnHighFixable: null, scannedAt: null });
  });

});

describe('scanSbom — grype invocation', () => {
  it('runs grype over a temp SBOM file with the DB frozen, parses the report, and cleans up', async () => {
    let sbomPath = '';
    mockRun.mockImplementation(async (_bin: string, args: string[]) => {
      sbomPath = (args[0] as string).slice('sbom:'.length);
      expect(JSON.parse(fs.readFileSync(sbomPath, 'utf8'))).toEqual({ packages: [] });
      return report(match('CVE-1', 'Critical'), match('CVE-2', 'Medium'));
    });

    const r = await vs.scanSbom({ packages: [] }, 'build');

    const [bin, args, timeout, env, opts] = mockRun.mock.calls[0]!;
    expect(bin).toBe('grype');
    expect(args).toEqual([expect.stringMatching(/^sbom:.*sbom\.spdx\.json$/), '-o', 'json', '-q']);
    expect(timeout).toBe(300_000);
    expect(env).toMatchObject({ GRYPE_DB_AUTO_UPDATE: 'false', GRYPE_CHECK_FOR_APP_UPDATE: 'false', GRYPE_DB_CACHE_DIR: expect.any(String) });
    expect(opts).toEqual({ captureStdout: true });
    expect(r).toMatchObject({ critical: 1, high: 0, medium: 1, low: 0, scannedAt: expect.any(Date) });
    expect(fs.existsSync(sbomPath)).toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_scans_total', { trigger: 'build', outcome: 'scanned' });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_findings_total', { trigger: 'build', severity: 'critical' }, 1);
    expect(mockIncCounter).not.toHaveBeenCalledWith('plugin_vuln_findings_total', expect.objectContaining({ severity: 'high' }), expect.anything());
    expect(mockObserve).toHaveBeenCalledWith('plugin_vuln_scan_duration_seconds', { trigger: 'build' }, expect.any(Number));
  });

  it('honours GRYPE_DB_CACHE_DIR', async () => {
    process.env.GRYPE_DB_CACHE_DIR = '/var/cache/grype';
    try {
      mockRun.mockResolvedValue(report());
      await vs.scanSbom({}, 'rescan');
      expect(mockRun.mock.calls[0]![3]).toMatchObject({ GRYPE_DB_CACHE_DIR: '/var/cache/grype' });
    } finally {
      delete process.env.GRYPE_DB_CACHE_DIR;
    }
  });

  it('a grype failure is an error (counted failed), and still cleans up', async () => {
    let sbomPath = '';
    mockRun.mockImplementation(async (_b: string, args: string[]) => {
      sbomPath = (args[0] as string).slice('sbom:'.length);
      throw new Error('grype exited 1: db too old');
    });
    await expect(vs.scanSbom({}, 'rescan')).rejects.toThrow(/db too old/);
    expect(fs.existsSync(sbomPath)).toBe(false);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_scans_total', { trigger: 'rescan', outcome: 'failed' });
  });

  it('an unparseable report is an error, never a clean scan', async () => {
    mockRun.mockResolvedValue('garbage');
    await expect(vs.scanSbom({}, 'build')).rejects.toThrow(/not JSON/);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_scans_total', { trigger: 'build', outcome: 'failed' });
  });
});

describe('scanPluginImage — fail-closed', () => {
  it('returns the scan (stamped with its DB build time), the SBOM package names and the uncatalogued binaries', async () => {
    mockFetchImageSbom.mockResolvedValue({
      packages: [{ SPDXID: 'SPDXRef-Package-1', name: 'openssl' }],
      files: [{ fileName: 'bin/hadolint', SPDXID: 'SPDXRef-File-h' }],
    });
    mockRun.mockImplementation(async (_b: string, args: string[]) => (args[0] === 'db'
      ? JSON.stringify({ built: '2026-11-01T00:00:00Z', valid: true })
      : report(match('CVE-1', 'High'))));
    const out = await vs.scanPluginImage(REF, REGISTRY, 'build');
    expect(out.packages).toEqual(['openssl']);
    expect(out.uncataloguedBinaries).toEqual(['/bin/hadolint']);
    expect(out.scan).toMatchObject({ high: 1, dbBuiltAt: new Date('2026-11-01T00:00:00Z') });
    expect(mockFetchImageSbom).toHaveBeenCalledWith(REF, REGISTRY);
  });

  it('a caller-supplied DB build time is used as-is (the rescan reads it once per pass)', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [] });
    mockRun.mockResolvedValue(report());
    const at = new Date('2026-11-02T00:00:00Z');
    const out = await vs.scanPluginImage(REF, REGISTRY, 'rescan', { dbBuiltAt: at });
    expect(out.scan?.dbBuiltAt).toBe(at);
    expect(mockRun.mock.calls.map((c) => c[1][0])).toEqual([expect.stringMatching(/^sbom:/)]);
  });

  it('an SBOM that will not verify leaves the image unscanned with unknown packages', async () => {
    mockFetchImageSbom.mockRejectedValue(new Error('attestation invalid'));
    await expect(vs.scanPluginImage(REF, REGISTRY, 'build')).resolves.toEqual({ scan: null, packages: null, uncataloguedBinaries: null });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_scans_total', { trigger: 'build', outcome: 'failed' });
  });

  it('a failed grype leaves it unscanned but keeps the package list', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [{ name: 'zlib' }] });
    mockRun.mockRejectedValue(new Error('boom'));
    await expect(vs.scanPluginImage(REF, REGISTRY, 'rescan')).resolves.toEqual({ scan: null, packages: ['zlib'], uncataloguedBinaries: [] });
  });

  it('refreshDb updates the DB first, and a failed update still scans on the DB present', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [] });
    mockRun.mockImplementation(async (_b: string, args: string[]) => {
      if (args[0] === 'db' && args[1] === 'update') throw new Error('network down');
      return report();
    });
    const out = await vs.scanPluginImage(REF, REGISTRY, 'build', { refreshDb: true });
    expect(mockRun.mock.calls.map((c) => c[1].slice(0, 2).join(' '))).toEqual(['db update', 'db status', expect.stringMatching(/^sbom:.* -o$/)]);
    expect(out.scan).toMatchObject({ critical: 0 });
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_db_updates_total', { outcome: 'failed' });
  });
});

describe('refreshVulnDb', () => {
  it('runs `grype db update` and reuses a recent refresh unless forced', async () => {
    mockRun.mockResolvedValue('');
    await vs.refreshVulnDb();
    expect(mockRun).toHaveBeenCalledWith('grype', ['db', 'update'], 600_000, expect.objectContaining({ GRYPE_CHECK_FOR_APP_UPDATE: 'false' }));
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_db_updates_total', { outcome: 'success' });

    await vs.refreshVulnDb();
    expect(mockRun).toHaveBeenCalledTimes(1);
    await vs.refreshVulnDb({ force: true });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one update', async () => {
    let release!: () => void;
    mockRun.mockReturnValue(new Promise<string>((r) => { release = () => r(''); }));
    const a = vs.refreshVulnDb({ force: true });
    const b = vs.refreshVulnDb({ force: true });
    release();
    await Promise.all([a, b]);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('throws when the update fails, and the next call retries', async () => {
    mockRun.mockRejectedValueOnce(new Error('offline'));
    await expect(vs.refreshVulnDb()).rejects.toThrow('offline');
    mockRun.mockResolvedValueOnce('');
    await vs.refreshVulnDb();
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('PLUGIN_GRYPE_DB_AUTO_UPDATE=false leaves the DB to the operator', async () => {
    process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE = 'FALSE';
    await vs.refreshVulnDb({ force: true });
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('grype DB cache housekeeping', () => {
  let cache = '';
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'grype-cache-'));
    process.env.GRYPE_DB_CACHE_DIR = cache;
  });
  afterEach(() => {
    delete process.env.GRYPE_DB_CACHE_DIR;
    delete process.env.PLUGIN_GRYPE_DB_CACHE_LIMIT_BYTES;
    fs.rmSync(cache, { recursive: true, force: true });
  });

  /** Lay out what an interrupted update leaves: an installed DB, two orphaned download dirs, a look-alike file. */
  function seed(): void {
    fs.mkdirSync(path.join(cache, '6'));
    fs.writeFileSync(path.join(cache, '6', 'vulnerability.db'), 'installed');
    for (const d of ['grype-db-download1570035802', 'grype-db-download2890394714']) {
      fs.mkdirSync(path.join(cache, d));
      fs.writeFileSync(path.join(cache, d, 'vulnerability.db'), 'x'.repeat(4096));
    }
    fs.writeFileSync(path.join(cache, 'grype-db-download.note'), 'a file, not a download dir');
  }

  it('removes only orphaned download DIRS, never the installed DB or other files', () => {
    seed();
    expect(vs.removeOrphanDownloads(cache)).toBe(2);
    expect(fs.readdirSync(cache).sort()).toEqual(['6', 'grype-db-download.note']);
    expect(fs.readFileSync(path.join(cache, '6', 'vulnerability.db'), 'utf8')).toBe('installed');
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_db_orphans_removed_total', {}, 2);
  });

  it('is a no-op on a missing cache dir', () => {
    expect(vs.removeOrphanDownloads(path.join(cache, 'absent'))).toBe(0);
  });

  it('cleans up BEFORE `grype db update` runs, so the update starts with the headroom', async () => {
    seed();
    let seenAtRun: string[] = [];
    mockRun.mockImplementation(async () => { seenAtRun = fs.readdirSync(cache).sort(); return ''; });
    await vs.refreshVulnDb({ force: true });
    expect(seenAtRun).toEqual(['6', 'grype-db-download.note']);
  });

  it('publishes the on-disk cache size and the declared limit after a refresh', async () => {
    seed();
    process.env.PLUGIN_GRYPE_DB_CACHE_LIMIT_BYTES = String(12 * 1024 ** 3);
    mockRun.mockResolvedValue('');
    await vs.refreshVulnDb({ force: true });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_db_cache_bytes', {}, vs.dirAllocatedBytes(cache));
    expect(vs.dirAllocatedBytes(cache)).toBeGreaterThan(0);
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_db_cache_limit_bytes', {}, 12 * 1024 ** 3);
  });

  it('still records the size when the update fails', async () => {
    mockRun.mockRejectedValue(new Error('offline'));
    await expect(vs.refreshVulnDb({ force: true })).rejects.toThrow('offline');
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_vuln_db_cache_bytes', {}, expect.any(Number));
    expect(mockSetGauge).not.toHaveBeenCalledWith('plugin_vuln_db_cache_limit_bytes', expect.anything(), expect.anything());
  });

  it('touches nothing when the DB is operator-managed (shared, read-only)', async () => {
    seed();
    process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE = 'false';
    await vs.refreshVulnDb({ force: true });
    expect(fs.readdirSync(cache)).toContain('grype-db-download1570035802');
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('inspectRunAsRoot — crane config', () => {
  let authDir = '';
  beforeEach(() => {
    mockWriteAuthConfig.mockImplementation(() => { authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-auth-test-')); return authDir; });
  });
  afterEach(() => { if (authDir) fs.rmSync(authDir, { recursive: true, force: true }); });

  it('reads the published platform\'s config USER with a pull-scoped credential, then removes it', async () => {
    mockRun.mockResolvedValue(JSON.stringify({ config: { User: 'root' } }));
    await expect(vs.inspectRunAsRoot(REF, REGISTRY)).resolves.toBe(true);
    expect(mockRun).toHaveBeenCalledWith('crane',
      ['--insecure', 'config', '--platform', 'linux/amd64', `registry:5000/org-org-1/trivy@${DIGEST}`],
      30_000, { DOCKER_CONFIG: authDir }, { captureStdout: true });
    expect(mockWriteAuthConfig).toHaveBeenCalledWith(REGISTRY, 'org-1', 30, 'pull');
    expect(fs.existsSync(authDir)).toBe(false);
  });

  it('a non-root USER is false; a TLS registry drops --insecure', async () => {
    mockRun.mockResolvedValue(JSON.stringify({ config: { User: '1000:1000' } }));
    await expect(vs.inspectRunAsRoot(REF, { ...REGISTRY, http: false })).resolves.toBe(false);
    expect(mockRun.mock.calls[0]![1][0]).toBe('config');
  });

  it('throws without a valid digest, and when crane fails', async () => {
    await expect(vs.inspectRunAsRoot({ ...REF, imageDigest: null }, REGISTRY)).rejects.toThrow(/no image digest/);
    await expect(vs.inspectRunAsRoot({ ...REF, imageDigest: 'latest' }, REGISTRY)).rejects.toThrow(/no image digest/);
    mockRun.mockRejectedValue(new Error('crane: 401'));
    await expect(vs.inspectRunAsRoot(REF, REGISTRY)).rejects.toThrow('crane: 401');
    expect(fs.existsSync(authDir)).toBe(false);
  });
});

describe('onNewCriticalOrHigh', () => {
  const plugin = { id: 'p-1', orgId: 'org-1', name: 'trivy', version: '1.0.0', imageDigest: DIGEST, listingVersionIds: [] as string[] };
  const after = { critical: 3, high: 1, medium: 0, low: 0, criticalFixable: 0, highFixable: 0, scannedAt: new Date(), findings: [], dbBuiltAt: null };
  const f = (id: string, severity: 'critical' | 'high') => ({ id, severity, packageName: 'openssl', packageVersion: '1.0', fixedIn: [] });

  it('counts exactly the NEW findings it is given, labelled by severity and listed', () => {
    vs.onNewCriticalOrHigh(plugin, [f('CVE-1', 'critical'), f('CVE-2', 'critical')], after);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_new_findings_total', { severity: 'critical', listed: 'false' }, 2);
    expect(mockIncCounter).not.toHaveBeenCalledWith('plugin_vuln_new_findings_total', expect.objectContaining({ severity: 'high' }), expect.anything());

    vs.onNewCriticalOrHigh({ ...plugin, listingVersionIds: ['lv-1'] }, [f('CVE-3', 'high')], after);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_new_findings_total', { severity: 'high', listed: 'true' }, 1);
  });
});
