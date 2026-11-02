// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Public image collection: maintenance asks image-registry to delete the
 * digests the candidate query selects, marks them collected, and leaves a
 * digest a tag still resolves to (409) for a later pass.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

import { DIGEST_A, DIGEST_B, setupEcosystemHarness, wireEcosystemHarness } from './helpers/ecosystem-harness.js';

const h = setupEcosystemHarness();
const gc = await import('../src/services/ecosystem/image-gc.js');
const maintenance = await import('../src/services/ecosystem/maintenance.js');
await wireEcosystemHarness(h);

const { db } = h;
const REPO = 'public/acme/lint';
const DAY = 24 * 3_600_000;

/** The SQL text of a raw `execute` call (nested fragments flattened). */
const sqlText = (q: unknown): string => ((q as { queryChunks?: Array<{ value?: string[]; queryChunks?: unknown[] }> }).queryChunks ?? [])
  .map((c) => (Array.isArray(c.value) ? c.value.join('') : c.queryChunks ? sqlText(c) : '')).join('?');

/** Answer the candidate query with `rows`. */
const answer = (rows: Array<Record<string, unknown>>) => {
  db.execute.handler = () => ({ rows });
};

beforeEach(() => {
  db.reset();
  h.registryPost.mockClear();
  h.findRefs.mockReset();
  h.findRefs.mockImplementation(async () => []);
});

describe('public image collection', () => {
  it('collects the selected digests and marks every version of them collected', async () => {
    const now = new Date('2027-06-01T00:00:00Z');
    const v1 = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.0', imageRepository: REPO, imageDigest: DIGEST_A, yankedAt: new Date(now.getTime() - 200 * DAY) });
    const v2 = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.1', imageRepository: REPO, imageDigest: DIGEST_B, yankedAt: new Date(now.getTime() - 200 * DAY) });
    answer([{ image_repository: REPO, image_digest: DIGEST_A, version: '1.0.0' }]);
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 200, body: { data: { deleted: true } } }) as never);

    expect(await gc.collectYankedPublicImages(now)).toBe(1);
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/gc', { imageRepository: REPO, digest: DIGEST_A }, expect.anything());
    expect(v1.imageCollectedAt).toEqual(now);
    expect(v2.imageCollectedAt ?? null).toBeNull();

    // The candidate query carries the retention cutoff and the shared reference
    // rule: deployed manifests, live declared resolutions, open deployed exposures.
    const text = sqlText(db.execute.calls[0]);
    expect(text).toContain('image_collected_at IS NULL');
    expect(text).toContain('pipeline_step_manifests');
    expect(text).toContain('pipeline_plugin_resolution');
    expect(text).toContain('plugin_vuln_exposure');
    expect((db.execute.calls[0] as { queryChunks: unknown[] }).queryChunks).toContainEqual(new Date(now.getTime() - gc.PUBLIC_IMAGE_GC_DAYS * DAY));
  });

  it('leaves a digest a tag still resolves to (409) uncollected, and keeps going', async () => {
    const v = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.0', imageRepository: REPO, imageDigest: DIGEST_A, yankedAt: new Date(0) });
    answer([{ image_repository: REPO, image_digest: DIGEST_A, version: '1.0.0' }, { image_repository: REPO, image_digest: DIGEST_B, version: '1.0.1' }]);
    h.registryPost
      .mockImplementationOnce(async () => ({ statusCode: 409, body: { message: 'still tagged' } }) as never)
      .mockImplementationOnce(async () => ({ statusCode: 200, body: { data: { deleted: false } } }) as never);
    expect(await gc.collectYankedPublicImages()).toBe(0);
    expect(h.registryPost).toHaveBeenCalledTimes(2);
    expect(v.imageCollectedAt ?? null).toBeNull();
  });

  it('keeps a digest a pipeline came to reference after the candidate query (findVersionReferences, re-asked before the delete)', async () => {
    const v = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.0', imageRepository: REPO, imageDigest: DIGEST_A, yankedAt: new Date(0) });
    answer([{ image_repository: REPO, image_digest: DIGEST_A, version: '1.0.0' }, { image_repository: REPO, image_digest: DIGEST_B, version: '1.0.1' }]);
    h.findRefs.mockImplementation(async (target: any) => (target.imageDigest === DIGEST_A
      ? [{ pipelineId: 'pipe-1', orgId: 'org-1', source: 'declared', pipelineName: 'p', pipelineDeleted: false, steps: ['Build/lint'] }] : []));
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 200, body: { data: { deleted: true } } }) as never);
    expect(await gc.collectYankedPublicImages()).toBe(1);
    expect(h.registryPost).toHaveBeenCalledTimes(1);
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/gc', { imageRepository: REPO, digest: DIGEST_B }, expect.anything());
    expect(v.imageCollectedAt ?? null).toBeNull();
    expect(h.findRefs).toHaveBeenCalledWith(expect.objectContaining({ imageDigest: DIGEST_A }));
  });

  it('keeps the image when the reference check fails (fail closed)', async () => {
    answer([{ image_repository: REPO, image_digest: DIGEST_A, version: '1.0.0' }]);
    h.findRefs.mockImplementation(async () => { throw new Error('db down'); });
    expect(await gc.collectYankedPublicImages()).toBe(0);
    expect(h.registryPost).not.toHaveBeenCalled();
  });

  it('runs from the ecosystem maintenance pass', async () => {
    db.execute.handler = () => ({ rows: [] });
    const out = await maintenance.runEcosystemMaintenance();
    expect(out).toMatchObject({ publicImagesCollected: 0, failures: 0 });
  });
});
