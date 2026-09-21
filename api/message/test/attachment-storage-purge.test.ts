// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for deleteAttachmentsByOrgPrefix — the org-purge blob cleanup that the
 * platform cascade calls (platform holds no object-storage client). Verifies the
 * org key prefix (trailing slash), pagination across ContinuationToken, the
 * deleted count, and that a page failure THROWS (so a partial purge is not
 * silently reported as success).
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';

const mockSend = jest.fn<(cmd: unknown) => Promise<unknown>>();
const mockEmitCounter = jest.fn<(...args: unknown[]) => void>();

// Mock the AWS SDK: S3Client.send is our spy; the command classes just capture
// their input so assertions can read Bucket/Prefix/ContinuationToken/Delete.
class FakeCommand { constructor(public input: Record<string, unknown>) {} }
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: class { send = mockSend; },
  PutObjectCommand: FakeCommand,
  GetObjectCommand: FakeCommand,
  DeleteObjectCommand: FakeCommand,
  DeleteObjectsCommand: class DeleteObjectsCommand extends FakeCommand {},
  ListObjectsV2Command: class ListObjectsV2Command extends FakeCommand {},
  HeadBucketCommand: FakeCommand,
  CreateBucketCommand: FakeCommand,
}));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  emitCounter: (...args: unknown[]) => mockEmitCounter(...args),
  envStr: (_k: string, d: string) => d,
  envBool: (_k: string, d: boolean) => d,
  envInt: (_k: string, d: number) => d,
}));

const { deleteAttachments, deleteAttachmentsByOrgPrefix, DELETE_OBJECTS_MAX_KEYS, generateThumbnail, thumbnailSiblingOf, thumbnailContentType } = await import('../src/services/attachment-storage.js');
const { Jimp } = await import('jimp');

const isList = (cmd: unknown) => cmd?.constructor?.name === 'ListObjectsV2Command';
const isDelete = (cmd: unknown) => cmd?.constructor?.name === 'DeleteObjectsCommand';

describe('deleteAttachmentsByOrgPrefix', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('lowercases the org into a trailing-slash prefix (no sibling over-match)', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (isList(cmd)) return { Contents: [], IsTruncated: false };
      return {};
    });

    await deleteAttachmentsByOrgPrefix('ORG-1');

    const listCall = mockSend.mock.calls.find((c) => isList(c[0]))![0] as { input: Record<string, unknown> };
    expect(listCall.input.Prefix).toBe('org-1/');
  });

  it('paginates across ContinuationToken and returns the total deleted count', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (isList(cmd)) {
        const token = (cmd as { input: { ContinuationToken?: string } }).input.ContinuationToken;
        if (!token) {
          return { Contents: [{ Key: 'org-1/a/1' }, { Key: 'org-1/b/2' }], IsTruncated: true, NextContinuationToken: 'page2' };
        }
        return { Contents: [{ Key: 'org-1/c/3' }], IsTruncated: false };
      }
      return {}; // delete
    });

    const deleted = await deleteAttachmentsByOrgPrefix('org-1');

    expect(deleted).toBe(3);
    // Two list pages + two delete batches (one per non-empty page).
    expect(mockSend.mock.calls.filter((c) => isList(c[0]))).toHaveLength(2);
    const deleteCalls = mockSend.mock.calls.filter((c) => isDelete(c[0]));
    expect(deleteCalls).toHaveLength(2);
    // Second list page carried the continuation token forward.
    const secondList = mockSend.mock.calls.filter((c) => isList(c[0]))[1][0] as { input: { ContinuationToken?: string } };
    expect(secondList.input.ContinuationToken).toBe('page2');
  });

  it('is a no-op (no delete) when the org has no blobs', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (isList(cmd)) return { Contents: [], IsTruncated: false };
      return {};
    });

    const deleted = await deleteAttachmentsByOrgPrefix('empty-org');
    expect(deleted).toBe(0);
    expect(mockSend.mock.calls.some((c) => isDelete(c[0]))).toBe(false);
  });

  it('THROWS on a page failure (a partial purge must not read as success)', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (isList(cmd)) return { Contents: [{ Key: 'org-1/a/1' }], IsTruncated: false };
      throw new Error('S3 unavailable'); // the DeleteObjects call fails
    });

    await expect(deleteAttachmentsByOrgPrefix('org-1')).rejects.toThrow('S3 unavailable');
  });
});

describe('deleteAttachmentsByOrgPrefix — per-key Errors', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('THROWS when DeleteObjects answers 200 but reports per-key Errors', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (isList(cmd)) return { Contents: [{ Key: 'org-1/a/1' }, { Key: 'org-1/b/2' }], IsTruncated: false };
      return { Errors: [{ Key: 'org-1/b/2', Code: 'AccessDenied' }] };
    });

    await expect(deleteAttachmentsByOrgPrefix('org-1')).rejects.toThrow(/Failed to delete 1 of 2/);
  });
});

const deleteKeysOf = (cmd: unknown): string[] =>
  ((cmd as { input: { Delete: { Objects: Array<{ Key: string }> } } }).input.Delete.Objects).map((o) => o.Key);

describe('deleteAttachments (bulk purge cleanup)', () => {
  beforeEach(() => { mockSend.mockReset(); mockEmitCounter.mockReset(); });

  it('chunks to the 1000-key DeleteObjects cap (keys + thumbnail siblings)', async () => {
    mockSend.mockResolvedValue({});
    const keys = Array.from({ length: 1500 }, (_, i) => `org-1/att-${i}/f.png`);

    const failed = await deleteAttachments(keys, { retryDelayMs: 0 });

    expect(failed).toEqual([]);
    const batches = mockSend.mock.calls.filter((c) => isDelete(c[0])).map((c) => deleteKeysOf(c[0]));
    expect(batches.length).toBe(3); // 3000 keys (1500 + 1500 thumbs)
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(DELETE_OBJECTS_MAX_KEYS);
    const all = batches.flat();
    expect(new Set(all).size).toBe(3000);
    expect(all).toContain('org-1/att-0/f.png');
    expect(all).toContain('org-1/att-0/thumb');
  });

  it('retries ONLY the keys DeleteObjects reported in Errors', async () => {
    let call = 0;
    mockSend.mockImplementation(async () => {
      call += 1;
      return call === 1 ? { Errors: [{ Key: 'org-1/a/x.pdf', Code: 'SlowDown' }] } : {};
    });

    const failed = await deleteAttachments(['org-1/a/x.pdf', 'org-1/b/y.pdf'], { retryDelayMs: 0 });

    expect(failed).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(deleteKeysOf(mockSend.mock.calls[1][0])).toEqual(['org-1/a/x.pdf']);
    expect(mockEmitCounter).not.toHaveBeenCalled();
  });

  it('retries a thrown batch, then reports persistently-failing keys as orphans (never throws)', async () => {
    mockSend.mockRejectedValue(new Error('S3 unavailable'));

    const failed = await deleteAttachments(['org-1/a/x.pdf'], { attempts: 3, retryDelayMs: 0 });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect([...failed].sort()).toEqual(['org-1/a/thumb', 'org-1/a/x.pdf']);
    expect(mockEmitCounter).toHaveBeenCalledWith('message_attachment_blob_orphans_total', {}, 2);
  });

  it('treats an Errors entry without a Key as a whole-batch failure', async () => {
    mockSend.mockResolvedValueOnce({ Errors: [{ Code: 'InternalError' }] }).mockResolvedValue({});

    const failed = await deleteAttachments(['org-1/a/x.pdf'], { retryDelayMs: 0 });

    expect(failed).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(deleteKeysOf(mockSend.mock.calls[1][0]).sort()).toEqual(['org-1/a/thumb', 'org-1/a/x.pdf']);
  });

  it('is a no-op for an empty key list', async () => {
    expect(await deleteAttachments([])).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('generateThumbnail + key helpers', () => {
  it('thumbnailSiblingOf targets a "thumb" sibling of the stored blob', () => {
    // Derived from the STORAGE KEY, never from the attachment row's id: the path
    // segment is a uuid minted for the blob, and the row id is assigned by the
    // database. Upload, download and purge must all name the same object.
    expect(thumbnailSiblingOf('org-1/blob-uuid/photo.png')).toBe('org-1/blob-uuid/thumb');
  });

  it('thumbnailContentType keeps PNG (alpha), else JPEG', () => {
    expect(thumbnailContentType('image/png')).toBe('image/png');
    expect(thumbnailContentType('image/jpeg')).toBe('image/jpeg');
    expect(thumbnailContentType('image/gif')).toBe('image/jpeg');
  });

  it('downscales an oversized image to fit the thumbnail box', async () => {
    const src = await new Jimp({ width: 800, height: 400, color: 0xff0000ff }).getBuffer('image/png');
    const thumb = await generateThumbnail(Buffer.from(src), 'image/png');
    expect(thumb).not.toBeNull();
    expect(thumb!.contentType).toBe('image/png');
    const decoded = await Jimp.read(thumb!.body);
    // Long edge clamped to the 320 box (aspect preserved: 800x400 → 320x160).
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(320);
  });

  it('returns null for an already-small image (no upscale)', async () => {
    const src = await new Jimp({ width: 100, height: 40, color: 0x00ff00ff }).getBuffer('image/png');
    expect(await generateThumbnail(Buffer.from(src), 'image/png')).toBeNull();
  });

  it('returns null (never throws) on an undecodable buffer', async () => {
    expect(await generateThumbnail(Buffer.from('not an image'), 'image/png')).toBeNull();
  });
});
