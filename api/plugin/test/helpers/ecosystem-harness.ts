// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared set-up for the plugin-ecosystem service suites: the in-memory DB, the
 * module doubles (audit, notifications, the plugin service's freeze, SBOM
 * reads), a fake image-registry client, a fake quota service and a membership
 * probe — plus builders for callers and rows.
 *
 * Call {@link setupEcosystemHarness} at the TOP of a suite (before any
 * `await import()` of the code under test); then {@link wireEcosystemHarness}
 * once the ecosystem modules are imported.
 */

import { jest } from '@jest/globals';
import { bindTestAuditService, drizzleMock, stubModule } from '@pipeline-builder/api-core/testing';

import { createFakeEcosystemDb, type FakeEcosystemDb, type NewRow, type Row } from './fake-ecosystem-db.js';

export const SYSTEM_ORG = '000000000000000000000001';
export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;

export interface Harness {
  db: FakeEcosystemDb;
  audit: ReturnType<typeof bindTestAuditService>;
  notify: ReturnType<typeof jest.fn>;
  registryPost: ReturnType<typeof jest.fn>;
  /** image-registry `DELETE /internal/quarantine/:id`. */
  registryDelete: ReturnType<typeof jest.fn>;
  membership: ReturnType<typeof jest.fn>;
  quota: {
    check: ReturnType<typeof jest.fn>;
    getTier: ReturnType<typeof jest.fn>;
    /** The fail-closed tier read (null = unreadable) the Verified upkeep uses. */
    getTierStrict: ReturnType<typeof jest.fn>;
  };
  sbom: { current: ReturnType<typeof jest.fn>; public: ReturnType<typeof jest.fn> };
  /** Platform's `/internal/ecosystem/*` reads (Verified eligibility facts, approver counts). */
  platform: { eligibility: ReturnType<typeof jest.fn>; approvers: ReturnType<typeof jest.fn> };
  /** Set the tenant listings limit the fake quota service reports (-1 = unlimited). */
  setListingsLimit: (limit: number) => void;
  /** The background re-sign kick — recorded, never run: suites drive `runResignJobs` themselves. */
  resignKick: ReturnType<typeof jest.fn>;
}

/** Register every module double. Must run before the code under test is imported. */
export function setupEcosystemHarness(): Harness {
  const db = createFakeEcosystemDb();
  const actualData = jest.requireActual('@pipeline-builder/pipeline-data') as Record<string, unknown>;
  jest.unstable_mockModule('drizzle-orm', () => drizzleMock(db.ops));
  jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', { ...actualData, ...db.pipelineData }));

  // The ecosystem's `ecosystemAudit` → api-core `recordAudit`, bound to a spy.
  const audit = bindTestAuditService('plugin');

  const notify = jest.fn(async () => 'sent');
  jest.unstable_mockModule('../../src/services/ecosystem-notifications.js', () => ({ enqueueEcosystemNotification: notify }));

  // freezeVersion against the fake table: pins the digest like the real one.
  jest.unstable_mockModule('../../src/services/plugin-service.js', () => ({
    pluginService: {
      freezeVersion: jest.fn(async (orgId: string, id: string, digest: string | null) => {
        const row = (db.tables.plugins ?? []).find((p) => p.id === id && p.orgId === orgId && !p.deletedAt);
        if (!row) throw Object.assign(new Error('Plugin not found'), { statusCode: 404 });
        if ((row.imageDigest ?? null) !== (digest ?? null)) throw Object.assign(new Error('digest mismatch'), { code: 'PLUGIN_DIGEST_MISMATCH' });
        row.frozenAt ??= new Date();
        return row;
      }),
    },
  }));

  const sbom = {
    current: jest.fn(async () => ({ packages: [{ name: 'openssl', versionInfo: '3.0.1' }, { name: 'curl', versionInfo: '8.0' }] })),
    public: jest.fn(async () => ({ packages: [{ name: 'openssl', versionInfo: '3.0.0' }, { name: 'curl', versionInfo: '8.0' }] })),
  };
  class ImageVerificationError extends Error {
    constructor(message: string) { super(message); this.name = 'ImageVerificationError'; }
  }
  jest.unstable_mockModule('../../src/helpers/supply-chain.js', () => ({
    fetchImageSbom: sbom.current,
    fetchPublicImageSbom: sbom.public,
    ImageVerificationError,
    // The build side (docker-build imports these); no suite builds through the harness.
    DIGEST_RE: /^sha256:[0-9a-f]{64}$/,
    SUPPLY_CHAIN_STEPS: 2,
    attachSupplyChain: jest.fn(async () => undefined),
    verifyImageSignature: jest.fn(async () => undefined),
  }));

  const registryPost = jest.fn(async (path: string, body: any) => ({
    statusCode: 200,
    body: { data: path.endsWith('/plugin-publications') ? { imageRepository: `public/${body.publisherHandle}/${body.name}`, digest: body.digest } : {} },
  }));
  const registryDelete = jest.fn(async () => ({ statusCode: 200, body: { data: { deleted: 1 } } }));
  const membership = jest.fn(async () => false);

  let listingsLimit = -1;
  const quota = {
    check: jest.fn(async () => ({ allowed: true, limit: listingsLimit, used: 0, remaining: -1, resetAt: '', unlimited: listingsLimit === -1 })),
    getTier: jest.fn(async () => 'team'),
    getTierStrict: jest.fn(async (): Promise<string | null> => 'team'),
  };

  // An eligible org by default: a verified domain and an owner with MFA.
  const platform = {
    eligibility: jest.fn(async () => ({ verifiedDomains: ['acme.dev'], owners: 1, ownersWithMfa: 1 })),
    approvers: jest.fn(async () => ({ holders: 3, eligible: 3, superadmins: 1 })),
  };

  const resignKick = jest.fn();
  return { db, audit, notify, registryPost, registryDelete, membership, quota, sbom, platform, setListingsLimit: (n) => { listingsLimit = n; }, resignKick };
}

/** Plug the fakes into the imported ecosystem modules. */
export async function wireEcosystemHarness(h: Harness): Promise<void> {
  const { setRegistryClientForTests } = await import('../../src/services/ecosystem/registry.js');
  const { setMembershipProbeForTests } = await import('../../src/services/ecosystem/conflict.js');
  const { setBaseImageProbeForTests } = await import('../../src/services/ecosystem/execute.js');
  const { initEcosystem } = await import('../../src/services/ecosystem/context.js');
  const { setPlatformReadsForTests } = await import('../../src/services/ecosystem/platform-reads.js');
  const { setResignKickForTests } = await import('../../src/services/ecosystem/resign.js');
  setResignKickForTests(h.resignKick as () => void);
  setRegistryClientForTests({ post: h.registryPost as any, get: jest.fn() as any, delete: h.registryDelete as any });
  setPlatformReadsForTests(h.platform as any);
  setMembershipProbeForTests(h.membership as any);
  // base-image age: no registry in tests (a test that needs it overrides this).
  setBaseImageProbeForTests(async () => null);
  initEcosystem({ quotaService: h.quota as any });
}

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

export interface TestCaller {
  userId: string;
  orgId: string;
  parentOrgId?: string;
  principalType: string;
  name?: string;
  isSuperAdmin: boolean;
  permissions: string[];
  features: string[];
}

export function tenant(over: Partial<TestCaller> = {}): TestCaller {
  return {
    userId: 'u-acme',
    orgId: 'org-acme',
    principalType: 'user',
    name: 'alice',
    isSuperAdmin: false,
    permissions: ['plugins:read', 'plugins:write', 'plugins:publish', 'publishers:manage'],
    features: [],
    ...over,
  };
}

export function moderator(userId = 'mod-1', over: Partial<TestCaller> = {}): TestCaller {
  return {
    userId,
    orgId: SYSTEM_ORG,
    principalType: 'user',
    name: userId,
    isSuperAdmin: false,
    permissions: ['plugins:read', 'plugins:moderate', 'publishers:verify'],
    features: [],
    ...over,
  };
}

export function loader(): TestCaller {
  return {
    userId: 'sa-loader',
    orgId: SYSTEM_ORG,
    principalType: 'service_account',
    name: 'official-catalog-loader',
    isSuperAdmin: false,
    permissions: ['plugins:read', 'plugins:write', 'plugins:publish'],
    features: [],
  };
}

/** A plugin version row that passes every submit gate. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pluginRow(over: NewRow = {}): any {
  return {
    orgId: 'org-acme',
    name: 'lint',
    version: '1.0.0',
    visibility: 'public',
    license: 'MIT',
    readmeMd: '# Lint\n\nLints.',
    readmeHtml: '<h1>Lint</h1>',
    imageDigest: DIGEST_A,
    imageSource: 'built',
    scannedAt: new Date(),
    vulnCritical: 0,
    vulnHigh: 0,
    vulnMedium: 0,
    vulnLow: 0,
    runAsRoot: false,
    buildType: 'build_image',
    pluginType: 'CodeBuildStep',
    computeType: 'SMALL',
    secrets: [],
    requiredMetadata: [],
    requiredVars: [],
    metadataTypes: {},
    varsTypes: {},
    networkEgress: [],
    env: {},
    installCommands: [],
    commands: ['lint'],
    timeout: null,
    failureBehavior: 'fail',
    primaryOutputDirectory: null,
    smokeTest: null,
    dockerfile: 'FROM alpine',
    description: 'Lints code.',
    summary: 'Lints code.',
    displayName: 'Lint',
    keywords: ['lint'],
    category: 'quality',
    homepageUrl: null,
    sourceUrl: 'https://github.com/acme/lint',
    documentationUrl: null,
    icon: null,
    changelog: null,
    metadataSources: { summary: 'spec', description: 'spec', sourceUrl: 'dockerfile' },
    metadata: {},
    breaking: false,
    createdBy: 'u-acme',
    deletedAt: null,
    frozenAt: null,
    isDefault: true,
    lifecycle: 'production',
    yankedAt: null,
    yankReason: null,
    ...over,
  };
}

/** The Official publisher + (optionally) a tenant publisher that accepted the current terms. */
export function seedPublishers(db: FakeEcosystemDb, opts: { tenantTier?: string } = {}): { official: Row; acme: Row } {
  const official = db.seed('publishers', { handle: 'pipeline-builder', ownerOrgId: SYSTEM_ORG, displayName: 'Pipeline Builder', tier: 'official' });
  const acme = db.seed('publishers', {
    handle: 'acme',
    ownerOrgId: 'org-acme',
    displayName: 'Acme',
    tier: opts.tenantTier ?? 'community',
    termsVersion: '2026-09-21',
    termsAcceptedAt: new Date(),
  });
  return { official, acme };
}
