// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared attachment-image object-URL cache: one fetch per id
 * (coalesced across concurrent callers), LRU eviction revokes the evicted URL,
 * and a failed fetch is not cached so a later mount retries.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getAttachmentImageUrl, clearAttachmentImageCache } from '@/lib/attachment-image-cache';

let urlSeq = 0;
const revoked: string[] = [];

beforeEach(() => {
  urlSeq = 0;
  revoked.length = 0;
  // jsdom lacks these; mint a distinct URL per blob so we can track identity.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:mock/${urlSeq++}`;
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => { revoked.push(u); };
});

afterEach(() => {
  clearAttachmentImageCache();
});

const blob = () => new Blob(['x']);

describe('attachment-image-cache', () => {
  it('fetches once per id and reuses the object URL across calls', async () => {
    const fetchBlob = jest.fn<() => Promise<Blob>>().mockResolvedValue(blob());

    const first = await getAttachmentImageUrl('a1', fetchBlob);
    const second = await getAttachmentImageUrl('a1', fetchBlob);

    expect(first).toBe(second);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers onto a single fetch', async () => {
    const fetchBlob = jest.fn<() => Promise<Blob>>().mockResolvedValue(blob());

    const [a, b] = await Promise.all([
      getAttachmentImageUrl('a1', fetchBlob),
      getAttachmentImageUrl('a1', fetchBlob),
    ]);

    expect(a).toBe(b);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch — a later call retries', async () => {
    const fetchBlob = jest
      .fn<(id: string) => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(blob());

    await expect(getAttachmentImageUrl('a1', fetchBlob)).rejects.toThrow('boom');
    // Second attempt should re-fetch (not replay the rejected promise).
    const url = await getAttachmentImageUrl('a1', fetchBlob);
    expect(url).toMatch(/^blob:mock\//);
    expect(fetchBlob).toHaveBeenCalledTimes(2);
  });

  it('evicts and revokes the oldest URL past the cap (50)', async () => {
    const fetchBlob = jest.fn<() => Promise<Blob>>().mockResolvedValue(blob());

    // Fill to the cap, then one more to trigger a single eviction of id "0".
    for (let i = 0; i <= 50; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential to keep LRU order deterministic
      await getAttachmentImageUrl(`id-${i}`, fetchBlob);
    }

    // The first-inserted URL (from id-0) is the LRU victim and must be revoked.
    expect(revoked).toContain('blob:mock/0');
  });

  it('LRU-touches on access so a recently-read entry is not the eviction victim', async () => {
    const fetchBlob = jest.fn<() => Promise<Blob>>().mockResolvedValue(blob());

    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop
      await getAttachmentImageUrl(`id-${i}`, fetchBlob);
    }
    // Touch id-0 so it's most-recently-used, then insert a new id to force eviction.
    await getAttachmentImageUrl('id-0', fetchBlob);
    await getAttachmentImageUrl('id-new', fetchBlob);

    // id-1 (now the oldest) is evicted; id-0's URL (blob:mock/0) survives.
    expect(revoked).not.toContain('blob:mock/0');
  });
});
