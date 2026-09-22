// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/vuln-scan (W0.6): grype invocation over the signed SBOM,
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
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter, observe: mockObserve }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ pushTimeoutMs: 30_000 }) },
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const vs = await import('../src/helpers/vuln-scan.js');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = { orgId: 'org-1', name: 'trivy', imageDigest: DIGEST };
const REGISTRY = { host: 'registry', port: 5000, network: '', http: true };

const match = (id: string, severity: string, name = 'openssl', version = '1.0') => ({
  vulnerability: { id, severity },
  artifact: { name, version },
});
const report = (...matches: unknown[]) => JSON.stringify({ matches });

beforeEach(() => {
  jest.clearAllMocks();
  vs._resetVulnDbState();
  delete process.env.PLUGIN_GRYPE_DB_AUTO_UPDATE;
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
    expect(r).toMatchObject({ critical: 1, high: 1, medium: 1, low: 2 });
    expect(r.findings).toEqual([
      { id: 'CVE-1', severity: 'critical', packageName: 'openssl', packageVersion: '1.0' },
      { id: 'CVE-2', severity: 'high', packageName: 'curl', packageVersion: '8.0' },
    ]);
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
    expect(r.findings).toEqual([{ id: 'CVE-4', severity: 'high', packageName: '', packageVersion: '' }]);
  });

  it('a clean report is all zeros', () => {
    expect(vs.parseGrypeReport(report())).toEqual({ critical: 0, high: 0, medium: 0, low: 0, findings: [] });
  });

  it('throws on anything that is not a grype report (never a clean result)', () => {
    expect(() => vs.parseGrypeReport('not json')).toThrow(/not JSON/);
    expect(() => vs.parseGrypeReport('{}')).toThrow(/no matches array/);
    expect(() => vs.parseGrypeReport('null')).toThrow(/no matches array/);
    expect(() => vs.parseGrypeReport('{"matches":{}}')).toThrow(/no matches array/);
  });
});

describe('sbomPackageNames / isRootUser / scanColumns / hasNewCriticalOrHigh', () => {
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
    expect(vs.scanColumns({ critical: 1, high: 2, medium: 3, low: 4, scannedAt: at, findings: [] }))
      .toEqual({ vulnCritical: 1, vulnHigh: 2, vulnMedium: 3, vulnLow: 4, scannedAt: at });
    expect(vs.scanColumns(null)).toEqual({ vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, scannedAt: null });
  });

  it('new critical/high = a count grew; unscanned before counts as none known', () => {
    const after = { critical: 1, high: 0, medium: 0, low: 0 };
    expect(vs.hasNewCriticalOrHigh(null, after)).toBe(true);
    expect(vs.hasNewCriticalOrHigh({ critical: 1, high: 0 }, after)).toBe(false);
    expect(vs.hasNewCriticalOrHigh({ critical: 1, high: 0 }, { ...after, high: 1 })).toBe(true);
    expect(vs.hasNewCriticalOrHigh(null, { critical: 0, high: 0, medium: 5, low: 5 })).toBe(false);
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
  it('returns the scan and the SBOM package names', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [{ SPDXID: 'SPDXRef-Package-1', name: 'openssl' }] });
    mockRun.mockResolvedValue(report(match('CVE-1', 'High')));
    const out = await vs.scanPluginImage(REF, REGISTRY, 'build');
    expect(out.packages).toEqual(['openssl']);
    expect(out.scan).toMatchObject({ high: 1 });
    expect(mockFetchImageSbom).toHaveBeenCalledWith(REF, REGISTRY);
  });

  it('an SBOM that will not verify leaves the image unscanned with unknown packages', async () => {
    mockFetchImageSbom.mockRejectedValue(new Error('attestation invalid'));
    await expect(vs.scanPluginImage(REF, REGISTRY, 'build')).resolves.toEqual({ scan: null, packages: null });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_scans_total', { trigger: 'build', outcome: 'failed' });
  });

  it('a failed grype leaves it unscanned but keeps the package list', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [{ name: 'zlib' }] });
    mockRun.mockRejectedValue(new Error('boom'));
    await expect(vs.scanPluginImage(REF, REGISTRY, 'rescan')).resolves.toEqual({ scan: null, packages: ['zlib'] });
  });

  it('refreshDb updates the DB first, and a failed update still scans on the DB present', async () => {
    mockFetchImageSbom.mockResolvedValue({ packages: [] });
    mockRun.mockImplementation(async (_b: string, args: string[]) => {
      if (args[0] === 'db') throw new Error('network down');
      return report();
    });
    const out = await vs.scanPluginImage(REF, REGISTRY, 'build', { refreshDb: true });
    expect(mockRun.mock.calls.map((c) => c[1][0])).toEqual(['db', expect.stringMatching(/^sbom:/)]);
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
  const after = { critical: 3, high: 1, medium: 0, low: 0, scannedAt: new Date(), findings: [] };

  it('counts only the NEW critical/high findings, labelled by listed', () => {
    vs.onNewCriticalOrHigh(plugin, { critical: 1, high: 1 }, after);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_new_findings_total', { severity: 'critical', listed: 'false' }, 2);
    expect(mockIncCounter).not.toHaveBeenCalledWith('plugin_vuln_new_findings_total', expect.objectContaining({ severity: 'high' }), expect.anything());
  });

  it('treats an unscanned before as nothing known', () => {
    vs.onNewCriticalOrHigh({ ...plugin, listingVersionIds: ['lv-1'] }, null, after);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_new_findings_total', { severity: 'critical', listed: 'true' }, 3);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_vuln_new_findings_total', { severity: 'high', listed: 'true' }, 1);
  });
});
