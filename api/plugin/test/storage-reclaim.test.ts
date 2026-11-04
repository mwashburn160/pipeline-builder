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
import type { AnyFn } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const MB = 1024 * 1024;

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  getServiceAuthHeader: () => 'Bearer org-token',
}));
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => ({
  Config: { get: () => ({ services: { imageRegistryHost: 'image-registry', imageRegistryPort: 3000 } }) },
}));

/** The org's live plugin versions, as the DB would report them. */
let versions: Array<{ name: string; version: string; imageDigest: string | null }> = [];
/** `name:version` → the pipelines referencing it. */
let references: Record<string, Array<{ pipelineId: string; pipelineName: string | null }>> = {};
let referencesThrow = false;

jest.unstable_mockModule('@pipeline-builder/pipeline-data', () => ({
  schema: { plugin: { name: 'name', version: 'version', imageDigest: 'imageDigest', orgId: 'orgId', deletedAt: 'deletedAt' } },
  withTenantTx: async () => versions,
  runWithTenantContext: (_ctx: unknown, fn: () => unknown) => fn(),
  findVersionReferences: async (t: { pluginName: string; pluginVersion: string }) => {
    if (referencesThrow) throw new Error('references unreadable');
    return references[`${t.pluginName}:${t.pluginVersion}`] ?? [];
  },
  distinctPipelines: (refs: Array<{ pipelineId: string; pipelineName: string | null }>) => refs,
}));
jest.unstable_mockModule('drizzle-orm', () => ({
  and: (...a: unknown[]) => a,
  eq: (a: unknown, b: unknown) => [a, b],
  isNull: (a: unknown) => a,
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
  setStorageRegistryClientForTests({ get, delete: del } as never);
  del.mockResolvedValue({ statusCode: 200, body: { data: {} } });
});

describe('reclaimPlan', () => {
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
    expect(del).toHaveBeenCalledWith('/internal/storage-prune/acme', expect.objectContaining({
      body: { repo: 'org-acme/app', tag: '1.0.0' },
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

  it('reports a registry refusal rather than claiming success', async () => {
    eligible();
    del.mockResolvedValue({ statusCode: 403, body: {} });
    const outcome = await pruneVersion('acme', 'org-acme/app', '1.0.0');
    expect(outcome).toEqual(expect.objectContaining({ pruned: false, reason: 'registry_unavailable' }));
  });
});
