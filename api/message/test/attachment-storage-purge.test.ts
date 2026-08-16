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

const mockSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

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

jest.unstable_mockModule('@pipeline-builder/api-core', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  envStr: (_k: string, d: string) => d,
  envBool: (_k: string, d: boolean) => d,
  envInt: (_k: string, d: number) => d,
}));

const { deleteAttachmentsByOrgPrefix, generateThumbnail, thumbnailKeyFor, thumbnailContentType } = await import('../src/services/attachment-storage.js');
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

describe('generateThumbnail + key helpers', () => {
  it('thumbnailKeyFor lowercases the org and targets a "thumb" sibling', () => {
    expect(thumbnailKeyFor('ORG-1', 'att-9')).toBe('org-1/att-9/thumb');
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
