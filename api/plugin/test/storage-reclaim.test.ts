// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `storage-reclaim` — what an org's registry storage is spent on, and which of
 * it can actually be freed.
 *
 * This module is a JOIN, and the whole reason it exists is that neither half can
 * answer alone: image-registry knows what deleting a version would free (it
 * depends on which layers are shared), and this service knows which versions a
 * pipeline still references. So the tests here are about ELIGIBILITY and about
 * the figures the surface is allowed to promise.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { drizzleMock, stubModule, type AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const MB = 1024 * 1024;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer org-token',
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: () => ({ services: { imageRegistryHost: 'image-registry', imageRegistryPort: 3000 } }) },
}));

/** The org's live plugin versions, as the DB would report them. */
let versions: Array<{ name: string; version: string; imageDigest: string | null }> = [];
/** `name:version` → the pipelines referencing it. */
let references: Record<string, Array<{ pipelineId: string; pipelineName: string | null }>> = {};
let referencesThrow = false;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => stubModule('@pipeline-builder/pipeline-data', {
  schema: { plugin: { name: 'name', version: 'version', imageDigest: 'imageDigest', orgId: 'orgId', deletedAt: 'deletedAt' } },
  withTenantTx: async () => versions,
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  findVersionReferences: async (t: { pluginName: string; pluginVersion: string }) => {
    if (referencesThrow) throw new Error('references unreadable');
    return references[`${t.pluginName}:${t.pluginVersion}`] ?? [];
  },
  distinctPipelines: (refs: Array<{ pipelineId: string; pipelineName: string | null }>) => refs,
}));
jest.unstable_mockModule('drizzle-orm', () => drizzleMock({}));
/** Kept build sources per version id (plugin-sources). */
let keptSources = new Map<string, { name: string; version: string; bytes: number }>();
let keptSourcesThrow = false;
jest.unstable_mockModule('../src/services/plugin-sources.js', () => ({
  sourceBytesByVersion: async () => {
    if (keptSourcesThrow) throw new Error('db down');
    return keptSources;
  },
}));

const { reclaimPlan, pruneVersion, setStorageRegistryClientForTests } = await import('../src/services/storage-reclaim.js');

const get = jest.fn<AnyFn>();
const del = jest.fn<AnyFn>();

/** The registry's breakdown response, or a failure. */
const breakdown = (entries: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  get.mockResolvedValue({ statusCode: 200, body: { data: { orgId: 'acme', bytes: 1000, entries, computedAt: 0, incomplete: false, ...over } } });

beforeEach(() => {
  jest.clearAllMocks();
  versions = [];
  references = {};
  referencesThrow = false;
  keptSources = new Map();
  keptSourcesThrow = false;
  setStorageRegistryClientForTests({ get, delete: del } as never);
  del.mockResolvedValue({ statusCode: 200, body: { data: {} } });
});

describe('reclaimPlan', () => {
  it('counts kept build sources toward the org\'s storage, per version and in total', async () => {
    versions = [{ name: 'app', version: '1.0.0', imageDigest: 'sha256:a' }];
    keptSources = new Map([
      ['id-1', { name: 'app', version: '1.0.0', bytes: 3 * MB }],
      // A soft-deleted version keeps its source (restore window) — it counts too.
      ['id-2', { name: 'app', version: '0.9.0', bytes: 5 * MB }],
    ]);
    breakdown([{ repo: 'org-acme/app', tag: '1.0.0', totalBytes: 400 * MB, marginalBytes: 10 * MB, published: false }]);

    const plan = (await reclaimPlan('acme'))!;
    expect(plan.candidates[0]).toEqual(expect.objectContaining({ version: '1.0.0', sourceBytes: 3 * MB }));
    expect(plan.sourceBytes).toBe(8 * MB);
    expect(plan.totalBytes).toBe(1000 + 8 * MB);
    expect(plan.sources).toEqual([
      { pluginId: 'id-2', pluginName: 'app', version: '0.9.0', bytes: 5 * MB },
      { pluginId: 'id-1', pluginName: 'app', version: '1.0.0', bytes: 3 * MB },
    ]);
    expect(plan.incomplete).toBe(false);
  });

  it('an unreadable kept-source figure reads as 0 and marks the plan incomplete', async () => {
    keptSourcesThrow = true;
    breakdown([]);
    const plan = (await reclaimPlan('acme'))!;
    expect(plan).toMatchObject({ sourceBytes: 0, totalBytes: 1000, incomplete: true });
  });

  it('offers an unreferenced private version, with the MARGINAL figure', async () => {
    versions = [{ name: 'app', version: '1.0.0', imageDigest: 'sha256:a' }];
    breakdown([{ repo: 'org-acme/app', tag: '1.0.0', totalBytes: 400 * MB, marginalBytes: 10 * MB, published: false }]);

    const plan = (await reclaimPlan('acme'))!;
    // Reads the registry with a token for the TENANT's org — a system-org token
    // would be (correctly) refused by the confined route.
    expect(get).toHaveBeenCalledWith('/internal/storage-breakdown/acme', expect.objectContaining({
      headers: { Authorization: 'Bearer org-token' },
    }));
    expect(plan.candidates[0]).toEqual(expect.objectContaining({
      pluginName: 'app', version: '1.0.0', eligible: true, reason: null, marginalBytes: 10 * MB,
    }));
    // Only the marginal bytes of ELIGIBLE candidates: summing everything would
    // promise the shared and published bytes too.
    expect(plan.reclaimableBytes).toBe(10 * MB);
  });

  it('refuses a version a pipeline still references, and names the pipeline', async () => {
    // The safety rule that already governs plugin deletion: no force override.
    versions = [{ name: 'app', version: '1.0.0', imageDigest: 'sha256:a' }];
    references['app:1.0.0'] = [{ pipelineId: 'p1', pipelineName: 'nightly' }];
    breakdown([{ repo: 'org-acme/app', tag: '1.0.0', totalBytes: 50 * MB, marginalBytes: 50 * MB, published: false }]);

    const plan = (await reclaimPlan('acme'))!;
    expect(plan.candidates[0]).toEqual(expect.objectContaining({
      eligible: false, reason: 'in_use', blockedBy: [{ id: 'p1', name: 'nightly' }],
    }));
    expect(plan.reclaimableBytes).toBe(0);
  });

  it('refuses a PUBLISHED copy, whose bytes stay billed until it is withdrawn', async () => {
    breakdown([{ repo: 'public/acme/app', tag: '1.0.0', totalBytes: 50 * MB, marginalBytes: 50 * MB, published: true }]);
    const plan = (await reclaimPlan('acme'))!;
    expect(plan.candidates[0]).toEqual(expect.objectContaining({ eligible: false, reason: 'published' }));
  });

  it('refuses an image no plugin version of ours owns', async () => {
    // Better to show it as ineligible than to offer a delete we cannot reason
    // about: an unowned image may be a leftover the operator should look at.
    breakdown([{ repo: 'org-acme/mystery', tag: '9.9.9', totalBytes: MB, marginalBytes: MB, published: false }]);
    const plan = (await reclaimPlan('acme'))!;
    expect(plan.candidates[0]).toEqual(expect.objectContaining({ eligible: false, reason: 'unknown_version' }));
  });

  it('FAILS CLOSED on eligibility when references cannot be read', async () => {
    // The refusal is the safety rule keeping a deployed pipeline's image alive,
    // so an unreadable reference set must make everything ineligible — never
    // prunable by default.
    versions = [{ name: 'app', version: '1.0.0', imageDigest: 'sha256:a' }];
    referencesThrow = true;
    breakdown([{ repo: 'org-acme/app', tag: '1.0.0', totalBytes: 50 * MB, marginalBytes: 50 * MB, published: false }]);

    const plan = (await reclaimPlan('acme'))!;
    expect(plan.candidates[0]).toEqual(expect.objectContaining({ eligible: false, reason: 'in_use' }));
  });

  it('carries `incomplete` so the surface can say the picture is partial', async () => {
    breakdown([], { incomplete: true });
    expect((await reclaimPlan('acme'))!.incomplete).toBe(true);
  });

  it('returns null — not an empty plan — when the registry cannot answer', async () => {
    // An empty list would read as "nothing to free", the opposite of the truth
    // and the worse failure for someone who is out of space.
    get.mockResolvedValue({ statusCode: 503, body: {} });
    expect(await reclaimPlan('acme')).toBeNull();
    get.mockRejectedValue(new Error('unreachable'));
    expect(await reclaimPlan('acme')).toBeNull();
  });
});

describe('pruneVersion', () => {
  const eligible = () => {
    versions = [{ name: 'app', version: '1.0.0', imageDigest: 'sha256:a' }];
    breakdown([{ repo: 'org-acme/app', tag: '1.0.0', totalBytes: 50 * MB, marginalBytes: 30 * MB, published: false }]);
  };

  it('deletes the version and reports what it freed', async () => {
    eligible();
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual({ pruned: true, repo: 'org-acme/app', tag: '1.0.0', freedBytes: 30 * MB, reason: null });
    // In the query string: InternalHttpClient.delete sends no body, so a body
    // in the options would reach the registry as nothing at all.
    expect(del).toHaveBeenCalledWith('/internal/storage-prune/acme?repo=org-acme%2Fapp&tag=1.0.0', expect.not.objectContaining({
      body: expect.anything(),
    }));
  });

  it('RE-CHECKS eligibility at the moment of deletion, not from the request', async () => {
    // The caller's figures may be a minute old, and in that minute a pipeline
    // could have started referencing the version.
    eligible();
    references['app:1.0.0'] = [{ pipelineId: 'p1', pipelineName: 'nightly' }];
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual(expect.objectContaining({ pruned: false, reason: 'in_use' }));
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a version that is not in the plan at all', async () => {
    eligible();
    const outcome = await pruneVersion('acme', 'org-acme/other', '1.0.0');
    expect(outcome).toEqual(expect.objectContaining({ pruned: false, reason: 'unknown_version' }));
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes nothing when the plan cannot be read', async () => {
    get.mockResolvedValue({ statusCode: 503, body: {} });
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual(expect.objectContaining({ pruned: false, reason: 'registry_unavailable' }));
    expect(del).not.toHaveBeenCalled();
  });

  it('answers registry_unavailable (not a thrown 500) when the prune call cannot reach the registry', async () => {
    // InternalHttpClient THROWS on a transport failure (it is not the null-
    // returning safe client). The route turns `registry_unavailable` into its
    // 503 + failure audit; a throw escaped both as a bare 500.
    eligible();
    del.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:3000'));
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual({ pruned: false, repo: 'org-acme/app', tag: '1.0.0', freedBytes: 0, reason: 'registry_unavailable' });
  });

  it('reports a registry refusal rather than claiming success', async () => {
    eligible();
    del.mockResolvedValue({ statusCode: 403, body: {} });
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual(expect.objectContaining({ pruned: false, reason: 'registry_unavailable' }));
  });
});
