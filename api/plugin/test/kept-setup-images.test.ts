// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/kept-setup-images: gate-refused images from the setup
 * catalog load, kept for promotion — who may keep one (system org only), the
 * record, promotion through the CURRENT gates (refused while findings remain,
 * stored through the build's own success tail once an advisory-id waiver
 * covers them), the duplicate-version refusal, the TTL sweep and the clean-up
 * when a passing build supersedes a kept image. The database is the in-memory
 * fake ecosystem db; scanner, registry and plugin service are mocked.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';
import { createFakeEcosystemDb } from './helpers/fake-ecosystem-db.js';
import { apiCoreMock } from './helpers/mock-api-core.js';

const db = createFakeEcosystemDb();
const SYSTEM_ORG = '000000000000000000000001';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const CRIT = { id: 'CVE-2026-1', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] };

// -- scanner / registry / gates' collaborators ---------------------------------
const mockAssertVulnDbFresh = jest.fn<(...a: any[]) => Promise<Date>>(async () => new Date());
class MockVulnDbStaleError extends Error {}
jest.unstable_mockModule('../src/helpers/vuln-scan.js', () => ({
  assertVulnDbFresh: mockAssertVulnDbFresh,
  VulnDbStaleError: MockVulnDbStaleError,
  // The real builder is covered by vuln-scan.test.ts; the fields the promotion reads back.
  scanSummary: (_scan: any, input: any) => ({ trigger: input.trigger, imageDigest: input.imageDigest, waived: input.waived.map((f: any) => f.id), kev: 0 }),
}));
const FACTS = {
  vulnCritical: 1,
  vulnHigh: 0,
  vulnMedium: 0,
  vulnLow: 0,
  vulnCriticalFixable: 1,
  vulnHighFixable: 0,
  scannedAt: new Date('2026-11-01'),
  runAsRoot: false,
  packages: ['openssl'],
  findings: [CRIT],
  scan: { dbBuiltAt: new Date('2026-11-01') },
  uncataloguedBinaries: [],
};
const mockEstablishImageFacts = jest.fn<(...a: any[]) => Promise<any>>(async () => FACTS);
const mockAssertPostBuildCompliance = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../src/helpers/image-facts.js', () => ({
  establishImageFacts: mockEstablishImageFacts,
  assertPostBuildCompliance: mockAssertPostBuildCompliance,
}));
class MockImageVerificationError extends Error {}
const mockVerifyImageSignature = jest.fn<(...a: any[]) => Promise<void>>(async () => undefined);
const mockDiscardPluginImage = jest.fn<(...a: any[]) => Promise<{ deleted: number }>>(async () => ({ deleted: 3 }));
jest.unstable_mockModule('../src/helpers/supply-chain.js', () => ({
  discardPluginImage: mockDiscardPluginImage,
  verifyImageSignature: mockVerifyImageSignature,
  ImageVerificationError: MockImageVerificationError,
}));
jest.unstable_mockModule('../src/helpers/registry-auth.js', () => ({
  imageRepository: (name: string, _r: unknown, orgId: string) => `registry:5000/${orgId === SYSTEM_ORG ? 'system' : `org-${orgId}`}/${name}`,
}));

// -- the success tail's collaborators ------------------------------------------
const mockDeployVersion = jest.fn<(...a: any[]) => Promise<any>>();
jest.unstable_mockModule('../src/services/plugin-service.js', () => ({ pluginService: { deployVersion: mockDeployVersion } }));
const mockSubmitAfterBuild = jest.fn<(...a: any[]) => Promise<any>>(async () => ({ ok: true, message: 'Publish request pending', requestId: 'r-1', status: 'pending' }));
jest.unstable_mockModule('../src/services/ecosystem/requests.js', () => ({ submitAfterBuild: mockSubmitAfterBuild }));

// -- platform -------------------------------------------------------------------
const mockAudit = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: mockAudit }));
const mockIncCounter = jest.fn();
const mockSetGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter: mockIncCounter, setGauge: mockSetGauge }));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ host: 'registry', port: 5000, network: '', http: true }) },
}));
const tenantContexts: unknown[] = [];
jest.unstable_mockModule('drizzle-orm', () => drizzleMock(db.ops));
jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  ...db.pipelineData,
  runWithTenantContext: async (ctx: unknown, fn: () => unknown) => { tenantContexts.push(ctx); return fn(); },
}));

const kept = await import('../src/services/kept-setup-images.js');

const record = { orgId: SYSTEM_ORG, name: 'trivy', version: '1.0.0', commands: ['trivy'], visibility: 'public', dockerfile: 'Dockerfile', quotaResetAt: '2026-11-01T00:00:00.000Z' } as any;
const caller = { userId: 'sa-loader', orgId: SYSTEM_ORG, principalType: 'service_account', isSuperAdmin: false, permissions: [], features: [] };
const build = { userId: 'sa-loader', access: { isSystemAdmin: false, canPublish: true }, pluginRecord: record, publish: { caller } };
const gateRefusal = () => Object.assign(new Error('PLUGIN_VULN_GATE: 1 fixable Critical'), { code: 'PLUGIN_VULN_GATE', statusCode: 422, details: { critical: 1, findings: [CRIT] } }) as any;
const keep = (over: Record<string, unknown> = {}) =>
  kept.keepSetupImage({ orgId: SYSTEM_ORG, image: { imageDigest: DIGEST, imageSource: 'built' }, refusal: gateRefusal(), build, ...over } as any);
const rows = () => db.tables.plugin_kept_setup_images ?? [];
const SYSTEM = { orgId: SYSTEM_ORG, userId: 'mod-1' };

beforeEach(() => {
  jest.clearAllMocks();
  db.reset();
  tenantContexts.length = 0;
  mockEstablishImageFacts.mockResolvedValue(FACTS);
  mockDeployVersion.mockImplementation(async (insert: any) => ({ id: 'p-new', name: insert.name, version: insert.version, imageDigest: insert.imageDigest }));
});
afterEach(() => {
  delete process.env.PLUGIN_VULN_WAIVERS;
  delete process.env.PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS;
});

describe('honoursSetupLoad', () => {
  it('honours the marker for the system org only', () => {
    expect(kept.honoursSetupLoad(SYSTEM_ORG, true)).toBe(true);
    expect(kept.honoursSetupLoad('org-acme', true)).toBe(false);
    expect(kept.honoursSetupLoad(SYSTEM_ORG, false)).toBe(false);
    expect(kept.honoursSetupLoad(SYSTEM_ORG, undefined)).toBe(false);
  });
});

describe('keepSetupImage', () => {
  it('records the refusal, the build to replay and an expiry PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS out — one row per image, refreshed on a re-refusal', async () => {
    process.env.PLUGIN_KEPT_SETUP_IMAGE_TTL_DAYS = '7';
    const now = new Date('2026-11-02T00:00:00Z');
    const id = await keep({ now });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      id,
      orgId: SYSTEM_ORG,
      pluginName: 'trivy',
      pluginVersion: '1.0.0',
      imageDigest: DIGEST,
      imageSource: 'built',
      refusalCode: 'PLUGIN_VULN_GATE',
      refusalFindings: [CRIT],
      keptBy: 'sa-loader',
      expiresAt: new Date('2026-11-09T00:00:00Z'),
    });
    // The refused build's quota slot was refunded: a promoted version must not carry its period.
    expect((rows()[0]!.build as any).pluginRecord.quotaResetAt).toBeNull();
    expect((rows()[0]!.build as any).publish).toEqual({ caller });

    await keep({ now: new Date('2026-11-03T00:00:00Z') });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.expiresAt).toEqual(new Date('2026-11-10T00:00:00Z'));
  });

  it('lists the org\'s kept images without the stored build record', async () => {
    await keep();
    const [v] = await kept.listKeptSetupImages(SYSTEM_ORG);
    expect(v).toMatchObject({ pluginName: 'trivy', refusalCode: 'PLUGIN_VULN_GATE', visibility: 'public', publishRequest: true });
    expect(v).not.toHaveProperty('build');
    expect(await kept.listKeptSetupImages('org-acme')).toEqual([]);
  });
});

describe('promoteKeptSetupImage', () => {
  it('REFUSES (409, findings) while the current gates still fail it — the row stays, its refusal refreshed, audited', async () => {
    const id = await keep();
    const err = await kept.promoteKeptSetupImage(id, SYSTEM).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'PLUGIN_VULN_GATE', details: expect.objectContaining({ findings: [CRIT], keptSetupImageId: id }) });
    expect(mockDeployVersion).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'plugin.setup_image.promote_refused',
      actorId: 'mod-1',
      orgId: SYSTEM_ORG,
      details: expect.objectContaining({ errorCode: 'PLUGIN_VULN_GATE', findings: ['CVE-2026-1'], imageDigest: DIGEST }),
    }));
    // The current gates ran on a re-verified, re-scanned image over a fresh DB.
    expect(mockAssertVulnDbFresh).toHaveBeenCalled();
    expect(mockVerifyImageSignature).toHaveBeenCalledWith({ orgId: SYSTEM_ORG, name: 'trivy', imageDigest: DIGEST }, expect.anything());
    expect(mockEstablishImageFacts).toHaveBeenCalledWith({ orgId: SYSTEM_ORG, name: 'trivy', imageDigest: DIGEST }, expect.anything(), 'Dockerfile', 'promote');
  });

  it('PROMOTES once an advisory-id waiver covers the findings: stored through the build\'s success tail, the row dropped, audited', async () => {
    const id = await keep();
    process.env.PLUGIN_VULN_WAIVERS = 'trivy@1.0.0:2099-12-31:CVE-2026-1';
    const out = await kept.promoteKeptSetupImage(id, SYSTEM);

    expect(out.plugin).toEqual({ id: 'p-new', name: 'trivy', version: '1.0.0', imageDigest: DIGEST });
    expect(mockDeployVersion).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'trivy', imageDigest: DIGEST, imageSource: 'built', vulnCriticalFixable: 1, scanSummary: expect.objectContaining({ trigger: 'promote', waived: ['CVE-2026-1'] }), quotaResetAt: null }),
      'sa-loader',
      { isSystemAdmin: false, canPublish: true },
    );
    // The same post-store steps as a passing build: the publish request the upload asked for.
    expect(mockSubmitAfterBuild).toHaveBeenCalledWith(caller, 'p-new');
    expect(out.messages).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'INFO', message: 'Publish request: Publish request pending' })]));
    expect(rows()).toHaveLength(0);
    const actions = mockAudit.mock.calls.map((c: any) => c[0].action);
    // `kept` is the keep() above; then the promotion's own two.
    expect(actions).toEqual(['plugin.setup_image.kept', 'plugin.vuln.waived', 'plugin.setup_image.promoted']);
    expect(mockAudit.mock.calls[2]![0]).toMatchObject({ targetId: 'p-new', details: expect.objectContaining({ refusedFor: 'PLUGIN_VULN_GATE', waived: 1 }) });
  });

  it('refuses a compliance BLOCK the same way', async () => {
    const id = await keep();
    mockEstablishImageFacts.mockResolvedValueOnce({ ...FACTS, vulnCriticalFixable: 0, findings: [] });
    mockAssertPostBuildCompliance.mockRejectedValueOnce(Object.assign(new Error('COMPLIANCE_VIOLATION: blocked'), { code: 'COMPLIANCE_VIOLATION', statusCode: 403 }));
    await expect(kept.promoteKeptSetupImage(id, SYSTEM)).rejects.toMatchObject({ statusCode: 409, code: 'COMPLIANCE_VIOLATION' });
    expect(rows()).toHaveLength(1);
  });

  it('409 when the version already exists; 404 for an unknown id or another org\'s row', async () => {
    const id = await keep();
    db.seed('plugins', { orgId: SYSTEM_ORG, name: 'trivy', version: '1.0.0', imageDigest: OTHER_DIGEST });
    await expect(kept.promoteKeptSetupImage(id, SYSTEM)).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(mockEstablishImageFacts).not.toHaveBeenCalled();
    await expect(kept.promoteKeptSetupImage('nope', SYSTEM)).rejects.toMatchObject({ statusCode: 404 });
    await expect(kept.promoteKeptSetupImage(id, { orgId: 'org-acme', userId: 'u' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('503 on a stale vulnerability DB or an unscannable image; 409 on a signature that no longer verifies — the row stays', async () => {
    const id = await keep();
    mockAssertVulnDbFresh.mockRejectedValueOnce(new MockVulnDbStaleError('DB is 50h old'));
    await expect(kept.promoteKeptSetupImage(id, SYSTEM)).rejects.toMatchObject({ statusCode: 503 });
    mockVerifyImageSignature.mockRejectedValueOnce(new MockImageVerificationError('bad signature'));
    await expect(kept.promoteKeptSetupImage(id, SYSTEM)).rejects.toMatchObject({ statusCode: 409, code: 'IMAGE_VERIFICATION_FAILED' });
    mockEstablishImageFacts.mockResolvedValueOnce({ ...FACTS, scannedAt: null, scan: null });
    await expect(kept.promoteKeptSetupImage(id, SYSTEM)).rejects.toMatchObject({ statusCode: 503, code: 'IMAGE_SCAN_UNAVAILABLE' });
    expect(rows()).toHaveLength(1);
    expect(mockDeployVersion).not.toHaveBeenCalled();
  });
});

describe('sweepKeptSetupImages', () => {
  it('discards EXPIRED kept images from the registry and drops their rows (elevated), keeps the rest, and publishes the count', async () => {
    await keep({ now: new Date(Date.now() - 40 * 86_400_000) }); // expired (30-day TTL)
    await keep({ image: { imageDigest: OTHER_DIGEST, imageSource: 'built' } }); // fresh
    const out = await kept.sweepKeptSetupImages();
    expect(out).toEqual({ discarded: 1, remaining: 1 });
    expect(tenantContexts).toEqual([{ isSuperAdmin: true }]);
    expect(mockDiscardPluginImage).toHaveBeenCalledWith({
      repository: 'registry:5000/system/trivy',
      digest: DIGEST,
      registry: expect.anything(),
      orgId: SYSTEM_ORG,
      context: expect.objectContaining({ scope: 'kept-setup-image', reason: 'expired', refusalCode: 'PLUGIN_VULN_GATE' }),
    });
    // The row's deletion is on the trail with its reason.
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugin.setup_image.discarded', details: expect.objectContaining({ reason: 'expired', imageDiscarded: true }) }));
    expect(rows().map((r) => r.imageDigest)).toEqual([OTHER_DIGEST]);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_kept_setup_image_sweep_total', { reason: 'expired', outcome: 'discarded' });
    expect(mockSetGauge).toHaveBeenCalledWith('plugin_kept_setup_images', {}, 1);
  });

  it('keeps the IMAGE (drops only the row) when a stored version references its digest; a failed discard keeps the row for the next sweep', async () => {
    await keep({ now: new Date(Date.now() - 40 * 86_400_000) });
    db.seed('plugins', { orgId: SYSTEM_ORG, name: 'trivy', version: '1.0.1', imageDigest: DIGEST });
    await kept.sweepKeptSetupImages();
    expect(mockDiscardPluginImage).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);

    db.reset();
    await keep({ now: new Date(Date.now() - 40 * 86_400_000) });
    mockDiscardPluginImage.mockRejectedValueOnce(new Error('registry 503'));
    await kept.sweepKeptSetupImages();
    expect(rows()).toHaveLength(1);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_kept_setup_image_sweep_total', { reason: 'expired', outcome: 'failed' });
  });
});

describe('supersedeKeptSetupImages', () => {
  it('a passing build of the same name+version under ANOTHER digest discards the kept image; the same digest and other versions are left alone', async () => {
    await keep();
    await keep({ build: { ...build, pluginRecord: { ...record, version: '1.0.1' } } });
    await kept.supersedeKeptSetupImages(SYSTEM_ORG, 'trivy', '1.0.0', OTHER_DIGEST);
    expect(mockDiscardPluginImage).toHaveBeenCalledTimes(1);
    expect(mockIncCounter).toHaveBeenCalledWith('plugin_kept_setup_image_sweep_total', { reason: 'superseded', outcome: 'discarded' });
    expect(rows().map((r) => r.pluginVersion)).toEqual(['1.0.1']);

    await kept.supersedeKeptSetupImages(SYSTEM_ORG, 'trivy', '1.0.1', DIGEST);
    expect(rows()).toHaveLength(1);
    // A tenant never keeps setup images: nothing to look up.
    await kept.supersedeKeptSetupImages('org-acme', 'trivy', '1.0.1', OTHER_DIGEST);
    expect(rows()).toHaveLength(1);
  });
});
