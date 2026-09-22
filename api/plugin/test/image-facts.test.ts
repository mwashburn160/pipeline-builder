// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/image-facts — what the build worker establishes about a
 * pushed, signed image before persisting it: scan, USER, and the
 * post-build compliance check the upload deferred.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockScanPluginImage = jest.fn<(...a: any[]) => Promise<any>>();
const mockInspectRunAsRoot = jest.fn<(...a: any[]) => Promise<boolean>>();
jest.unstable_mockModule('../src/helpers/vuln-scan.js', () => ({
  scanPluginImage: mockScanPluginImage,
  inspectRunAsRoot: mockInspectRunAsRoot,
  isRootUser: (u: unknown) => { const n = typeof u === 'string' ? u.trim().split(':')[0] : ''; return n === '' || n === '0' || n === 'root'; },
  scanColumns: (scan: any) => (scan
    ? { vulnCritical: scan.critical, vulnHigh: scan.high, vulnMedium: scan.medium, vulnLow: scan.low, scannedAt: scan.scannedAt }
    : { vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, scannedAt: null }),
}));

const mockValidatePlugin = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createComplianceClient: () => ({ validatePlugin: mockValidatePlugin }),
}));

const { assertPostBuildCompliance, establishImageFacts, resolveRunAsRoot } = await import('../src/helpers/image-facts.js');
const { AppError } = await import('@pipeline-builder/api-core');

const REF = { orgId: 'org-1', name: 'trivy', imageDigest: `sha256:${'b'.repeat(64)}` };
const REGISTRY = { host: 'registry', port: 5000, network: '', http: true };
const SCANNED_AT = new Date('2026-09-21T00:00:00Z');

const record = {
  orgId: 'org-1',
  name: 'trivy',
  version: '1.0.0',
  description: null,
  category: 'security',
  metadata: {},
  pluginType: 'CodeBuildStep',
  computeType: 'SMALL',
  primaryOutputDirectory: null,
  dockerfile: 'FROM alpine\nUSER app',
  env: { TOKEN: 'secret' },
  buildArgs: {},
  keywords: ['sca'],
  installCommands: [],
  commands: ['trivy'],
  visibility: 'org',
  timeout: null,
  failureBehavior: 'fail',
  buildType: 'build_image',
  secrets: [],
} as any;

beforeEach(() => { jest.clearAllMocks(); });

describe('resolveRunAsRoot', () => {
  it('reads the pushed image config first', async () => {
    mockInspectRunAsRoot.mockResolvedValueOnce(true);
    await expect(resolveRunAsRoot(REF, REGISTRY, 'FROM alpine\nUSER app')).resolves.toBe(true);
  });

  it("falls back to the Dockerfile's own final USER when the config can't be read", async () => {
    mockInspectRunAsRoot.mockRejectedValue(new Error('crane failed'));
    await expect(resolveRunAsRoot(REF, REGISTRY, 'FROM alpine\nUSER app')).resolves.toBe(false);
    await expect(resolveRunAsRoot(REF, REGISTRY, 'FROM alpine\nUSER 0:0')).resolves.toBe(true);
    // No USER in the plugin's own Dockerfile: the base image decides — unknown.
    await expect(resolveRunAsRoot(REF, REGISTRY, 'FROM alpine')).resolves.toBeNull();
    await expect(resolveRunAsRoot(REF, REGISTRY, null)).resolves.toBeNull();
  });
});

describe('establishImageFacts', () => {
  it('scans with a DB refresh (trigger build) and resolves USER', async () => {
    mockScanPluginImage.mockResolvedValueOnce({
      scan: { critical: 1, high: 2, medium: 3, low: 4, scannedAt: SCANNED_AT, findings: [] }, packages: ['openssl'],
    });
    mockInspectRunAsRoot.mockResolvedValueOnce(false);

    await expect(establishImageFacts(REF, REGISTRY, null)).resolves.toEqual({
      vulnCritical: 1, vulnHigh: 2, vulnMedium: 3, vulnLow: 4, scannedAt: SCANNED_AT, runAsRoot: false, packages: ['openssl'],
    });
    expect(mockScanPluginImage).toHaveBeenCalledWith(REF, REGISTRY, 'build', { refreshDb: true });
  });

  it('lands an unscannable image as UNSCANNED (all NULL), never a fake clean scan', async () => {
    mockScanPluginImage.mockResolvedValueOnce({ scan: null, packages: null });
    mockInspectRunAsRoot.mockResolvedValueOnce(true);

    await expect(establishImageFacts(REF, REGISTRY, null)).resolves.toEqual({
      vulnCritical: null, vulnHigh: null, vulnMedium: null, vulnLow: null, scannedAt: null, runAsRoot: true, packages: null,
    });
  });
});

describe('assertPostBuildCompliance', () => {
  const facts = { vulnCritical: 0, vulnHigh: 1, vulnMedium: 0, vulnLow: 0, scannedAt: SCANNED_AT, runAsRoot: false, packages: ['zlib'] };

  it('evaluates the deferred rules on the REAL image facts, nothing deferred', async () => {
    mockValidatePlugin.mockResolvedValueOnce({ blocked: false, violations: [] });

    await assertPostBuildCompliance('org-1', record, REF.imageDigest, facts);

    const [orgId, attributes, , entityId, entityName, action, deferred] = mockValidatePlugin.mock.calls[0]!;
    expect(orgId).toBe('org-1');
    expect(attributes).toMatchObject({
      name: 'trivy', signed: true, scanned: true, vulnCritical: 0, vulnHigh: 1, runAsRoot: false, packages: ['zlib'], tags: ['sca'],
    });
    expect([entityId, entityName, action, deferred]).toEqual([undefined, 'trivy', 'build', []]);
  });

  it('throws a permanent 403 COMPLIANCE_VIOLATION when the image is blocked', async () => {
    mockValidatePlugin.mockResolvedValueOnce({ blocked: true, violations: [{ ruleName: 'No critical CVEs', field: 'vulnCritical' }, { ruleName: '', field: 'runAsRoot' }] });

    const err = await assertPostBuildCompliance('org-1', record, REF.imageDigest, { ...facts, vulnCritical: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/^COMPLIANCE_VIOLATION: .*\(No critical CVEs, runAsRoot\)/);
  });

  it('propagates an unreachable compliance service (retryable, fail-closed)', async () => {
    mockValidatePlugin.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(assertPostBuildCompliance('org-1', record, REF.imageDigest, facts)).rejects.toThrow('ECONNREFUSED');
  });
});
