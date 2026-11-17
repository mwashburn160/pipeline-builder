// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract tests for the internal endpoints image-registry SERVES (api-core
 * `IMAGE_REGISTRY_INTERNAL`): each is mounted at its contract's method + path
 * with the contract's callers, and a sample request/response round-trips its
 * schemas. The table is built exactly as `route-coverage.test.ts` builds it.
 */

import { jest, describe, it, expect, beforeAll } from '@jest/globals';
import {
  IMAGE_REGISTRY_INTERNAL,
  PluginSignatureHeadersSchema,
  buildRouteTable,
  createQuotaService,
  internalContractsServedBy,
  type RouteTableEntry,
} from '@pipeline-builder/api-core';
import { findContractMountViolations, roundTripContractSample, type ContractSample } from '@pipeline-builder/api-core/testing';

process.env.JWT_SECRET ||= 'internal-contracts-test-secret';
process.env.IMAGE_REGISTRY_HOST ||= 'registry.invalid';
process.env.REGISTRY_TOKEN_PRIVATE_KEY ||= 'internal-contracts-test-key';
process.env.REGISTRY_TOKEN_CERTIFICATE ||= 'internal-contracts-test-cert';

// Same stub as route-coverage.test.ts: the token signer needs real x509
// material at import, which building a route table does not.
jest.unstable_mockModule('../src/services/token-service.js', () => ({
  authorizeAndIssue: jest.fn(async () => ({ token: '', accessCount: 0, storageGate: null })),
  parseScope: jest.fn(() => null),
  storageGateReason: jest.fn(() => ''),
}));

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PUBLIC_REPO = 'public/acme/lint';

const SAMPLES: Record<keyof typeof IMAGE_REGISTRY_INTERNAL, ContractSample> = {
  signPluginImage: { response: { repository: 'org-acme/lint', digest: DIGEST, signed: true } },
  discardPluginImage: {
    body: { repository: 'org-acme/lint', digest: DIGEST, context: { refusalCode: 'PLUGIN_VULN_GATE' } },
    response: { repository: 'org-acme/lint', digest: DIGEST, deleted: 3 },
  },
  publishPublicImage: {
    body: {
      sourceRepository: 'org-acme/lint',
      digest: DIGEST,
      publisherHandle: 'acme',
      name: 'lint',
      version: '1.2.0',
      tier: 'verified',
      publisherOrgId: 'acme',
      actorId: 'user-1',
    },
    response: { imageRepository: PUBLIC_REPO, digest: DIGEST },
  },
  resignPublicImage: {
    body: { imageRepository: PUBLIC_REPO, digest: DIGEST, publisherHandle: 'acme', tier: 'official', progress: { completed: 1, total: 4 } },
    response: { imageRepository: PUBLIC_REPO, digest: DIGEST, tier: 'official', publisher: 'acme' },
  },
  yankPublicVersion: {
    body: { imageRepository: PUBLIC_REPO, version: '1.2.0', digest: DIGEST },
    response: { imageRepository: PUBLIC_REPO, version: '1.2.0', digest: DIGEST, yanked: true },
  },
  retagPublicVersion: {
    body: { imageRepository: PUBLIC_REPO, version: '1.2.0', digest: DIGEST },
    response: { imageRepository: PUBLIC_REPO, version: '1.2.0', digest: DIGEST, tagged: true },
  },
  collectImage: {
    body: { imageRepository: 'system/lint', digest: DIGEST, version: '0.9.0' },
    response: { imageRepository: 'system/lint', digest: DIGEST, deleted: true },
  },
  verifyPublication: {
    query: { imageRepository: PUBLIC_REPO, digest: DIGEST },
    response: { signed: true, tier: 'verified', publisher: 'acme' },
  },
  invalidateVerifyCache: { body: { imageRepository: PUBLIC_REPO }, response: { invalidated: 2 } },
  deleteQuarantineRepository: { params: { submissionId: 'sub-1' }, response: { repository: 'quarantine/sub-1', deleted: 0 } },
  mintQuarantineCredential: {
    params: { submissionId: 'sub-1' },
    body: { ttlSeconds: 900 },
    response: { username: '_quarantine', password: 'jwt', expiresAt: '2026-11-17T00:00:00.000Z' },
  },
  orgStorageUsage: { params: { orgId: 'acme' }, response: { bytes: 1024 } },
  orgStorageBreakdown: {
    params: { orgId: 'acme' },
    query: {},
    response: {
      orgId: 'acme',
      bytes: 10,
      computedAt: 1,
      incomplete: false,
      entries: [{ repo: 'org-acme/lint', tag: '1.0.0', totalBytes: 10, marginalBytes: 4, published: false }],
    },
  },
  pruneOrgStorage: {
    params: { orgId: 'acme' },
    query: { repo: 'org-acme/lint', tag: '1.0.0' },
    response: { repo: 'org-acme/lint', tag: '1.0.0', pruned: true },
  },
  purgeOrgNamespace: { params: { orgId: 'acme' }, response: { repositories: 2, deleted: 5, failed: [] } },
};

let table: RouteTableEntry[];

beforeAll(async () => {
  const [{ createApp }, { mountRoutes }] = await Promise.all([
    import('@pipeline-builder/api-server'),
    import('../src/app-routes.js'),
  ]);
  const { app } = createApp({ enableOpenApi: false });
  mountRoutes(app, { quotaService: createQuotaService() });
  table = buildRouteTable(app);
});

describe('image-registry internal endpoint contracts', () => {
  it('has a sample for every contract image-registry serves', () => {
    expect(internalContractsServedBy('image-registry').map((c) => c.id).sort())
      .toEqual(Object.values(IMAGE_REGISTRY_INTERNAL).map((c) => c.id).sort());
  });

  it.each(Object.entries(IMAGE_REGISTRY_INTERNAL))('%s: mounted as declared and round-trips a sample', (name, contract) => {
    expect(findContractMountViolations(table, contract)).toEqual([]);
    expect(() => roundTripContractSample(contract, SAMPLES[name as keyof typeof IMAGE_REGISTRY_INTERNAL])).not.toThrow();
  });

  it('answers the retention view through the same breakdown contract', () => {
    const retention = { entries: [{ name: 'lint', version: '0.9.0', totalBytes: 8, marginalBytes: 8 }], computedAt: 1, incomplete: true };
    expect(() => roundTripContractSample(IMAGE_REGISTRY_INTERNAL.orgStorageBreakdown, {
      params: { orgId: 'system' }, query: { scope: 'retention' }, response: retention,
    })).not.toThrow();
  });

  it('keeps the routes\' own refusal messages in the schemas', () => {
    const msg = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) => r.error?.issues[0]?.message;
    expect(msg(PluginSignatureHeadersSchema.safeParse({ 'x-pb-repository': 'public/acme/lint', 'x-pb-digest': DIGEST })))
      .toBe('x-pb-repository must be system/<name>, org-<orgId>/<name> or quarantine/<submissionId>');
    expect(msg(PluginSignatureHeadersSchema.safeParse({ 'x-pb-repository': 'org-acme/lint' })))
      .toBe('x-pb-digest must be sha256:<64 hex>');
    expect(msg(IMAGE_REGISTRY_INTERNAL.discardPluginImage.body!.safeParse({ repository: 'quarantine/sub-1', digest: DIGEST })))
      .toBe('repository must be system/<name> or org-<orgId>/<name>');
    expect(msg(IMAGE_REGISTRY_INTERNAL.orgStorageUsage.params.safeParse({ orgId: 'a/b' })))
      .toBe('orgId must be one registry path component');
    expect(IMAGE_REGISTRY_INTERNAL.orgStorageUsage.params.parse({ orgId: 'ACME' })).toEqual({ orgId: 'acme' });
  });
});
