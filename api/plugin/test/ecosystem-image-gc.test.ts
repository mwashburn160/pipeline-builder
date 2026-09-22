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

/** The SQL text of a raw `execute` call. */
const sqlText = (q: unknown): string => ((q as { queryChunks?: Array<{ value?: string[] }> }).queryChunks ?? [])
  .map((c) => (Array.isArray(c.value) ? c.value.join('') : '')).join('?');

beforeEach(() => {
  db.reset();
  h.registryPost.mockClear();
});

describe('public image collection', () => {
  it('collects the selected digests and marks every version of them collected', async () => {
    const now = new Date('2027-06-01T00:00:00Z');
    const v1 = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.0', imageRepository: REPO, imageDigest: DIGEST_A, yankedAt: new Date(now.getTime() - 200 * DAY) });
    const v2 = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.1', imageRepository: REPO, imageDigest: DIGEST_B, yankedAt: new Date(now.getTime() - 200 * DAY) });
    db.execute.handler = () => ({ rows: [{ image_repository: REPO, image_digest: DIGEST_A }] });
    h.registryPost.mockImplementationOnce(async () => ({ statusCode: 200, body: { data: { deleted: true } } }) as never);

    expect(await gc.collectYankedPublicImages(now)).toBe(1);
    expect(h.registryPost).toHaveBeenCalledWith('/internal/plugin-publications/gc', { imageRepository: REPO, digest: DIGEST_A }, expect.anything());
    expect(v1.imageCollectedAt).toEqual(now);
    expect(v2.imageCollectedAt ?? null).toBeNull();

    // The candidate query carries the retention cutoff and both reference guards.
    const text = sqlText(db.execute.calls[0]);
    expect(text).toContain('image_collected_at IS NULL');
    expect(text).toContain('pipeline_step_manifests');
    expect((db.execute.calls[0] as { queryChunks: unknown[] }).queryChunks).toContainEqual(new Date(now.getTime() - gc.PUBLIC_IMAGE_GC_DAYS * DAY));
  });

  it('leaves a digest a tag still resolves to (409) uncollected, and keeps going', async () => {
    const v = db.seed('plugin_listing_versions', { listingId: 'l-1', version: '1.0.0', imageRepository: REPO, imageDigest: DIGEST_A, yankedAt: new Date(0) });
    db.execute.handler = () => ({ rows: [{ image_repository: REPO, image_digest: DIGEST_A }, { image_repository: REPO, image_digest: DIGEST_B }] });
    h.registryPost
      .mockImplementationOnce(async () => ({ statusCode: 409, body: { message: 'still tagged' } }) as never)
      .mockImplementationOnce(async () => ({ statusCode: 200, body: { data: { deleted: false } } }) as never);
    expect(await gc.collectYankedPublicImages()).toBe(0);
    expect(h.registryPost).toHaveBeenCalledTimes(2);
    expect(v.imageCollectedAt ?? null).toBeNull();
  });

  it('runs from the ecosystem maintenance pass', async () => {
    db.execute.handler = () => ({ rows: [] });
    const out = await maintenance.runEcosystemMaintenance();
    expect(out).toMatchObject({ publicImagesCollected: 0, failures: 0 });
  });
});
