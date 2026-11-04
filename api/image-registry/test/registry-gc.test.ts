// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for runRegistryGc — a data-loss path (it DELETEs manifests by digest).
 *
 * The three properties that matter for not nuking live images:
 *  - dry-run mode identifies candidates but issues ZERO deletes;
 *  - a real run deletes ONLY the stale (past-cutoff) tags;
 *  - a recent / retained tag is NEVER deleted.
 *
 * Mocked at the registry-client boundary so no real HTTP/registry is touched.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const listRepositoriesUnderPrefix = jest.fn<(p: string) => Promise<string[]>>();
const listTags = jest.fn<(name: string) => Promise<{ tags: string[] }>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<{ body: unknown; digest: string; mediaType: string }>>();
const getBlobJson = jest.fn<(name: string, digest: string) => Promise<unknown>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
const isNotFound = (e: unknown): boolean => (e as { statusCode?: number })?.statusCode === 404;

jest.unstable_mockModule('../src/services/registry-client.js', () => ({
  listRepositoriesUnderPrefix,
  listTags,
  getManifest,
  getBlobJson,
  deleteManifest,
  isNotFound,
  // Present on the module but unused by registry-gc.
  listRepositories: jest.fn(),
  putManifest: jest.fn(),
  headManifest: jest.fn(),
  headBlob: jest.fn(),
  getBlobStream: jest.fn(),
  mountBlob: jest.fn(),
}));

const invalidateStorageCache = jest.fn();
const computeStorageUsage = jest.fn<(prefix: string, opts?: unknown) => Promise<{ bytes: number; incomplete: boolean }>>();
const invalidateOrgStorageCache = jest.fn();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({
  invalidateStorageCache,
  invalidateOrgStorageCache,
  computeStorageUsage,
}));

const recordAuditMock = jest.fn();

const incCounter = jest.fn();
const setGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter, setGauge }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({ recordAudit: recordAuditMock }));

const {
  runRegistryGc, isAgeGcExempt, deleteQuarantineRepository, runQuarantineGc, deleteOrgNamespace,
} = await import('../src/services/registry-gc.js');
const { setPluginImageReferencesFetcherForTests } = await import('../src/services/plugin-image-references.js');
/** The digests the plugin service reports in use (default: none). */
let inUseDigests: string[] = [];
let referencesDown = false;

// A well-past-cutoff timestamp (default maxAgeDays = 30) and a fresh one.
const STALE = '2020-01-01T00:00:00.000Z';
const RECENT = new Date().toISOString();

/** Wire a single repo `org-acme/app` whose tags carry the given `created` times. */
function wireRepo(tagsToCreated: Record<string, string>) {
  listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
  listTags.mockResolvedValue({ tags: Object.keys(tagsToCreated) });
  getManifest.mockImplementation(async (_name, ref) => {
    const created = tagsToCreated[ref];
    if (!created) throw { response: { status: 404 } };
    return { body: { created }, digest: `sha256:digest-${ref}`, mediaType: 'application/vnd.oci.image.manifest.v1+json' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  inUseDigests = [];
  referencesDown = false;
  setPluginImageReferencesFetcherForTests(async () => {
    if (referencesDown) throw new Error('plugin service down');
    return inUseDigests;
  });
});

describe('runRegistryGc', () => {
  it('dry-run identifies candidates but issues ZERO deletes', async () => {
    wireRepo({ old: STALE, keep: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: true });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    // The stale tag is still counted as a candidate so the operator sees impact.
    expect(result.candidates).toBe(1);
    expect(result.reposScanned).toBe(1);
    // Dry-run must not touch the storage cache (nothing changed).
    expect(invalidateStorageCache).not.toHaveBeenCalled();
  });

  it('real run deletes ONLY the stale tag, leaving the recent tag untouched', async () => {
    wireRepo({ old: STALE, keep: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).toHaveBeenCalledTimes(1);
    expect(deleteManifest).toHaveBeenCalledWith('org-acme/app', 'sha256:digest-old');
    // The retained tag's digest must never be passed to delete.
    expect(deleteManifest).not.toHaveBeenCalledWith('org-acme/app', 'sha256:digest-keep');
    expect(result.deleted).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.perRepo).toEqual([{ repo: 'org-acme/app', scanned: 2, deleted: 1 }]);
    // A real deletion invalidates the storage rollup cache.
    expect(invalidateStorageCache).toHaveBeenCalledWith('org-acme/');
    // The durable audit names the pruned namespace's org as the affected org.
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'registry.gc',
      targetId: 'org-acme/',
      affectedOrgId: 'acme',
    }));
  });

  it('does not delete anything when every tag is within the retention window', async () => {
    wireRepo({ keep1: RECENT, keep2: RECENT });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.candidates).toBe(0);
    // No deletes → no cache invalidation.
    expect(invalidateStorageCache).not.toHaveBeenCalled();
  });

  it('throws when prefix is missing (guards against full-registry GC)', async () => {
    await expect(runRegistryGc({ prefix: '' })).rejects.toThrow('prefix is required');
    expect(listRepositoriesUnderPrefix).not.toHaveBeenCalled();
  });
});

const IMG = 'application/vnd.oci.image.manifest.v1+json';
const IDX = 'application/vnd.oci.image.index.v1+json';

describe('runRegistryGc — Fix 1: multi-arch INDEX age resolution', () => {
  it('ages an index via its child config `created` and deletes it (no silent skip)', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    // A single, non-floating version tag pointing at a multi-arch index.
    listTags.mockResolvedValue({ tags: ['v1'] });
    getManifest.mockImplementation(async (_name, ref) => {
      if (ref === 'v1') {
        // Index carries NO created / annotation / config — only child refs.
        return {
          body: { manifests: [{ digest: 'sha256:child-amd64', mediaType: IMG }] },
          digest: 'sha256:index',
          mediaType: IDX,
        };
      }
      if (ref === 'sha256:child-amd64') {
        return { body: { config: { digest: 'sha256:cfg' } }, digest: 'sha256:child-amd64', mediaType: IMG };
      }
      throw { response: { status: 404 } };
    });
    getBlobJson.mockResolvedValue({ created: STALE });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    // Previously the index had no timestamp → skipped forever. Now it's aged
    // from the child config and pruned.
    expect(deleteManifest).toHaveBeenCalledTimes(1);
    expect(deleteManifest).toHaveBeenCalledWith('org-acme/app', 'sha256:index');
    expect(result.deleted).toBe(1);
    expect(incCounter).not.toHaveBeenCalledWith('gc_skipped_no_timestamp_total', expect.anything());
  });
});

describe('runRegistryGc — Fix 2: retention safeguards (no live-tag data loss)', () => {
  it('never age-deletes a digest carrying a floating tag, even with an OLD build', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    listTags.mockResolvedValue({ tags: ['stable'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:s', mediaType: IMG });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    // `stable` re-pointed at a known-good old build must survive GC.
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('never age-deletes a digest shared by multiple tags (co-located pin)', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    // Two non-floating tags sharing one (old) digest — a version tag plus a pin.
    listTags.mockResolvedValue({ tags: ['v1.0.0', 'pinned'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:shared', mediaType: IMG });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it('never deletes a manifest referenced by a live index, even if a stale direct tag points at it', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    listTags.mockResolvedValue({ tags: ['v2', 'child-direct'] });
    getManifest.mockImplementation(async (_name, ref) => {
      if (ref === 'v2') {
        return { body: { manifests: [{ digest: 'sha256:child', mediaType: IMG }] }, digest: 'sha256:index2', mediaType: IDX };
      }
      // The child is ALSO directly tagged and its build is old — a naive GC
      // would prune it out from under the live index.
      if (ref === 'child-direct' || ref === 'sha256:child') {
        return { body: { config: { digest: 'sha256:cfg' } }, digest: 'sha256:child', mediaType: IMG };
      }
      throw { response: { status: 404 } };
    });
    getBlobJson.mockResolvedValue({ created: STALE });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    // The index (single non-floating tag) is prunable; its child is spared.
    expect(deleteManifest).toHaveBeenCalledWith('org-acme/app', 'sha256:index2');
    expect(deleteManifest).not.toHaveBeenCalledWith('org-acme/app', 'sha256:child');
    expect(result.deleted).toBe(1);
  });

  it('still prunes a genuinely stale single immutable version tag', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    listTags.mockResolvedValue({ tags: ['v0.9.0'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:old', mediaType: IMG });

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).toHaveBeenCalledWith('org-acme/app', 'sha256:old');
    expect(result.deleted).toBe(1);
  });

  it('never age-deletes a digest a plugin row or a pipeline still references, however old', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    listTags.mockResolvedValue({ tags: ['v0.9.0'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:old', mediaType: IMG });
    inUseDigests = ['sha256:old'];

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(incCounter).toHaveBeenCalledWith('gc_skipped_protected_total', { reason: 'in_use' });
  });

  it('FAILS SAFE: deletes nothing when the in-use references cannot be read', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app']);
    listTags.mockResolvedValue({ tags: ['v0.9.0'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:old', mediaType: IMG });
    referencesDown = true;

    const result = await runRegistryGc({ prefix: 'org-acme/', dryRun: false });

    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(incCounter).toHaveBeenCalledWith('gc_skipped_protected_total', { reason: 'references_unavailable' });
  });
});

// Plugin ecosystem a public/* image is collected only when yanked >180 days
// AND unreferenced by any step manifest — a decision only the plugin service can
// make (via POST /internal/plugin-publications/gc). The AGE sweep never reaches it.
describe('runRegistryGc — public/* and registry-meta/* are exempt from the age sweep', () => {
  it.each([
    ['public/acme/app', true],
    ['registry-meta/publications/acme/app', true],
    ['org-acme/app', false],
    ['system/app', false],
    ['publicity/app', false],
  ])('isAgeGcExempt(%s) = %s', (repo, exempt) => {
    expect(isAgeGcExempt(repo)).toBe(exempt);
  });

  it('never scans or deletes a public/* or registry-meta/* repository, even under a short prefix', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue(['public/acme/app', 'registry-meta/publications/acme/app']);
    listTags.mockResolvedValue({ tags: ['old'] });
    getManifest.mockResolvedValue({ body: { created: STALE }, digest: 'sha256:digest-old', mediaType: IMG });

    const result = await runRegistryGc({ prefix: 'p', dryRun: false });

    expect(listTags).not.toHaveBeenCalled();
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(result.reposScanned).toBe(0);
    expect(result.deleted).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// quarantine/* — anonymous plugin submissions
// -----------------------------------------------------------------------------

const Q = 'quarantine/0f3a2b1c-aaaa-4bbb-8ccc-123456789abc';
const IMAGE_MT = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_MT = 'application/vnd.oci.image.index.v1+json';

describe('deleteQuarantineRepository', () => {
  it('deletes every manifest — image, index children and cosign companions — once per digest', async () => {
    listTags.mockResolvedValue({ tags: ['1.0.0', 'sha256-abc.sig', 'latest'] });
    getManifest.mockImplementation(async (_n, ref) => {
      if (ref === '1.0.0' || ref === 'latest') {
        return { body: { manifests: [{ digest: 'sha256:child-amd64' }] }, digest: 'sha256:index', mediaType: INDEX_MT };
      }
      return { body: {}, digest: 'sha256:sig', mediaType: IMAGE_MT };
    });

    const result = await deleteQuarantineRepository(Q, 'requested');

    expect(result).toEqual({ repository: Q, deleted: 3 });
    expect(deleteManifest.mock.calls.map((c) => c[1]).sort()).toEqual(['sha256:child-amd64', 'sha256:index', 'sha256:sig']);
    expect(incCounter).toHaveBeenCalledWith('registry_quarantine_repositories_deleted_total', { reason: 'requested' });
    expect(invalidateStorageCache).toHaveBeenCalledWith('quarantine/');
  });

  it('is idempotent on a repo that is already gone', async () => {
    listTags.mockRejectedValue({ statusCode: 404 });
    await expect(deleteQuarantineRepository(Q, 'requested')).resolves.toEqual({ repository: Q, deleted: 0 });
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('refuses anything outside quarantine/', async () => {
    await expect(deleteQuarantineRepository('org-acme/app', 'requested')).rejects.toThrow(/Not a quarantine repository/);
    expect(listTags).not.toHaveBeenCalled();
  });
});

describe('runQuarantineGc', () => {
  const OLD = 'quarantine/old-submission';
  const NEW = 'quarantine/new-submission';

  beforeEach(() => {
    computeStorageUsage.mockResolvedValue({ bytes: 1234, incomplete: false });
    listRepositoriesUnderPrefix.mockResolvedValue([OLD, NEW]);
    listTags.mockImplementation(async (name) => ({ tags: name === OLD ? ['1.0.0', `sha256-${'a'.repeat(64)}.sig`] : ['2.0.0'] }));
    getManifest.mockImplementation(async (name, ref) => ({
      body: { created: name === OLD ? STALE : RECENT },
      digest: `sha256:${name.split('/')[1]}-${ref}`,
      mediaType: IMAGE_MT,
    }));
  });

  it('deletes only repos whose newest image is past 30 days, never a recent one', async () => {
    const result = await runQuarantineGc();

    expect(listRepositoriesUnderPrefix).toHaveBeenCalledWith('quarantine/');
    expect(result).toEqual({ reposScanned: 2, deleted: 1, skippedNoTimestamp: 0 });
    const deletedRepos = new Set(deleteManifest.mock.calls.map((c) => c[0]));
    expect(deletedRepos).toEqual(new Set([OLD]));
    expect(incCounter).toHaveBeenCalledWith('registry_quarantine_repositories_deleted_total', { reason: 'expired' });
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'registry.gc', targetId: OLD }));
    expect(setGauge).toHaveBeenCalledWith('registry_quarantine_repositories', {}, 1);
    expect(setGauge).toHaveBeenCalledWith('registry_quarantine_storage_bytes', {}, 1234);
  });

  it('dry-run deletes nothing', async () => {
    const result = await runQuarantineGc({ dryRun: true });
    expect(result.deleted).toBe(0);
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('keeps (and counts) a repo whose build time cannot be resolved', async () => {
    getManifest.mockResolvedValue({ body: {}, digest: 'sha256:x', mediaType: IMAGE_MT });
    getBlobJson.mockResolvedValue({});
    const result = await runQuarantineGc();
    expect(result.skippedNoTimestamp).toBe(2);
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(incCounter).toHaveBeenCalledWith('gc_skipped_no_timestamp_total', { reason: 'quarantine_no_created' });
  });
});


/**
 * `deleteOrgNamespace` — the org-delete cascade's registry leg.
 *
 * Before it, a deleted organization's images stayed on disk forever: billed to
 * nobody, with no tenant left to prune them and scheduled GC off by default.
 * It is a data-loss path on a namespace, so what it must NOT touch matters more
 * than what it does.
 */
describe('deleteOrgNamespace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getManifest.mockImplementation(async () => ({ body: {}, digest: 'sha256:d', mediaType: 'application/vnd.oci.image.manifest.v1+json' }));
    deleteManifest.mockResolvedValue(undefined);
  });

  it('purges every repository in the org\'s PRIVATE namespace, whatever its age', async () => {
    // Unlike the age sweep this is unconditional: the org is gone, so nothing
    // in its own namespace has an owner who could still want it.
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/app', 'org-acme/tool']);
    listTags.mockResolvedValue({ tags: ['1.0.0'] });

    const result = await deleteOrgNamespace('acme');
    expect(result).toEqual({ repositories: 2, deleted: 2, failed: [] });
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledWith('org-acme/');
    // The measured figure is cached, so the freed space has to be made visible.
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith('acme');
  });

  it('refuses anything the prefix listing should never have returned', async () => {
    // Belt and braces on a delete path: a published copy, a platform image or
    // another org's namespace must be impossible to reach through this call.
    // Other organizations INSTALL published listings and their pipelines pin
    // those digests, so removing them because a publisher's account went away
    // would break consumers.
    listRepositoriesUnderPrefix.mockResolvedValue([
      'public/acme/app', 'system/base', 'library/node', 'quarantine/sub-1', 'org-other/app',
    ]);
    listTags.mockResolvedValue({ tags: ['1.0.0'] });

    const result = await deleteOrgNamespace('acme');
    expect(result).toEqual({ repositories: 0, deleted: 0, failed: [] });
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('reports a repository it could not purge instead of claiming a clean teardown', async () => {
    // A partial purge leaves bytes on disk, and the cascade records the leg as
    // failed so an operator can reclaim them — silence would lose them.
    listRepositoriesUnderPrefix.mockResolvedValue(['org-acme/ok', 'org-acme/bad']);
    listTags.mockImplementation(async (name) => {
      if (name === 'org-acme/bad') throw { response: { status: 500 } };
      return { tags: ['1.0.0'] };
    });

    const result = await deleteOrgNamespace('acme');
    expect(result.repositories).toBe(1);
    expect(result.failed).toEqual(['org-acme/bad']);
  });

  it('is idempotent: a namespace already gone deletes nothing', async () => {
    listRepositoriesUnderPrefix.mockResolvedValue([]);
    const result = await deleteOrgNamespace('acme');
    expect(result).toEqual({ repositories: 0, deleted: 0, failed: [] });
    expect(invalidateOrgStorageCache).not.toHaveBeenCalled();
  });
});
