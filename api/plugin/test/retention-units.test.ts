// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The retention pass's small parts: its settings, the measurement summary, and
 * the image-registry client calls it adds (the system/<name> collection and
 * the retention breakdown).
 */

import { describe, it, expect, afterEach, jest } from '@jest/globals';

const { retentionConfig } = await import('../src/services/retention/config.js');
const { summarize } = await import('../src/services/retention/measure.js');
const { gcSystemImage, retentionBreakdown, setRegistryClientForTests, RegistryPublicationError } = await import('../src/services/ecosystem/registry.js');

const ENV = ['PLUGIN_RETENTION_ENABLED', 'PLUGIN_RETENTION_KEEP', 'PLUGIN_RETENTION_NOTICE_DAYS', 'PLUGIN_RETENTION_BATCH', 'PLUGIN_RETENTION_MAX_FRACTION'];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  setRegistryClientForTests(null);
});

describe('retentionConfig', () => {
  it('defaults: off, keep 3, 30 notice days, batch 50, max fraction 0.5', () => {
    expect(retentionConfig()).toEqual({ enabled: false, keep: 3, noticeDays: 30, batch: 50, maxFraction: 0.5 });
  });

  it('reads overrides and clamps them', () => {
    Object.assign(process.env, { PLUGIN_RETENTION_ENABLED: 'true', PLUGIN_RETENTION_KEEP: '0', PLUGIN_RETENTION_NOTICE_DAYS: '-4', PLUGIN_RETENTION_BATCH: '7', PLUGIN_RETENTION_MAX_FRACTION: '1' });
    expect(retentionConfig()).toEqual({ enabled: true, keep: 1, noticeDays: 0, batch: 7, maxFraction: 1 });
  });

  it.each(['0', '1.5', '-0.2', 'half'])('falls back to 0.5 for a max fraction outside (0, 1]: %s', (raw) => {
    process.env.PLUGIN_RETENTION_MAX_FRACTION = raw;
    expect(retentionConfig().maxFraction).toBe(0.5);
  });
});

describe('summarize (the measurement)', () => {
  const v = (version: string, state: string, rule: string) => ({ version, digest: null, state, rule, marginalBytes: null });
  it('counts versions outside the newest N, the hold-outs by rule and the retirable bytes, and says orphans are not measured', () => {
    const report: any = {
      generatedAt: 'g',
      keep: 2,
      storage: { measured: true, incomplete: false },
      plugins: [
        {
          name: 'lint',
          listed: true,
          marginalBytes: 40,
          versions: [
            v('1.4.0', 'keep', 'implicit_install'), v('1.3.0', 'keep', 'within_keep'), v('1.2.0', 'deprecate', 'superseded_in_major'),
            v('1.1.0', 'keep', 'install_pinned'), v('1.0.0', 'keep', 'template_pin'), v('0.9.0', 'keep', 'already_yanked'),
          ],
        },
        { name: 'fmt', listed: false, marginalBytes: 2, refusedReason: 'resolution_refresh_incomplete', versions: [v('1.1.0', 'keep', 'implicit_install'), v('1.0.0', 'refused', 'superseded_in_major')] },
      ],
    };
    const m = summarize(report);
    expect(m.plugins[0]).toEqual({ name: 'lint', listed: true, versions: 6, outsideKeep: 3, holdouts: { install_pinned: 1, template_pin: 1 }, retirable: 1, marginalBytes: 40 });
    expect(m.plugins[1]).toMatchObject({ outsideKeep: 1, retirable: 0, holdouts: {}, refusedReason: 'resolution_refresh_incomplete' });
    expect(m.totals).toEqual({ versions: 8, outsideKeep: 4, retirable: 1, marginalBytes: 42, holdouts: { install_pinned: 1, template_pin: 1 } });
    expect(m.orphanManifests.measured).toBe(false);
  });

  it('reports bytes as unknown when storage was not measured', () => {
    expect(summarize({ generatedAt: 'g', keep: 3, storage: { measured: false, incomplete: false }, plugins: [] } as any).totals.marginalBytes).toBeNull();
  });
});

describe('the image-registry calls', () => {
  it('gcSystemImage posts system/<name> with the retired version to the publications GC', async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const post = jest.fn(async (..._a: unknown[]) => ({ statusCode: 200, body: { data: { imageRepository: 'system/lint', digest, deleted: true } } }));
    setRegistryClientForTests({ post, get: jest.fn() } as never);
    await expect(gcSystemImage({ name: 'lint', version: '1.0.0', digest, actorId: 'system' })).resolves.toEqual({ deleted: true });
    expect(post).toHaveBeenCalledWith('/internal/plugin-publications/gc', { imageRepository: 'system/lint', digest, version: '1.0.0', actorId: 'system' }, expect.anything());
    post.mockResolvedValueOnce({ statusCode: 409, body: { message: 'tag latest' } } as never);
    await expect(gcSystemImage({ name: 'lint', version: '1.0.0', digest })).rejects.toBeInstanceOf(RegistryPublicationError);
  });

  it('retentionBreakdown reads the system org\'s retention scope, and answers null when image-registry cannot', async () => {
    const get = jest.fn(async (..._a: unknown[]) => ({ statusCode: 200, body: { data: { entries: [{ name: 'lint', version: '1.0.0', totalBytes: 1, marginalBytes: 1 }], computedAt: 1, incomplete: true } } }));
    setRegistryClientForTests({ post: jest.fn(), get } as never);
    await expect(retentionBreakdown()).resolves.toEqual({ entries: [{ name: 'lint', version: '1.0.0', totalBytes: 1, marginalBytes: 1 }], incomplete: true });
    expect(get).toHaveBeenCalledWith('/internal/storage-breakdown/000000000000000000000001?scope=retention', expect.anything());
    // A reply the contract cannot read is no answer — never an empty one, which would read as "nothing to free".
    get.mockResolvedValueOnce({ statusCode: 200, body: { data: {} } } as never);
    await expect(retentionBreakdown()).resolves.toBeNull();
    get.mockRejectedValueOnce(new Error('down') as never);
    await expect(retentionBreakdown()).resolves.toBeNull();
  });
});
