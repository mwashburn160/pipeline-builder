// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/public-publications — the ownership records that say which
 * org is billed for each `public/<handle>/<name>` repository (plugin ecosystem
 * ). Records are OCI artifacts stored IN the registry under
 * `registry-meta/publications/<handle>/<name>:owner`.
 *
 * The registry client is replaced by a small in-memory registry so records are
 * genuinely written, then read back through the same code the storage rollup
 * uses.
 */

import { createHash } from 'crypto';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

/** In-memory registry: `repo:tag` → manifest bytes, plus uploaded blobs. */
const manifests = new Map<string, { raw: Buffer; mediaType: string }>();
const blobs = new Map<string, Buffer>();
const notFound = () => Object.assign(new Error('not found'), { response: { status: 404 } });

const getManifest = jest.fn(async (name: string, ref: string) => {
  const m = manifests.get(`${name}:${ref}`);
  if (!m) throw notFound();
  return { body: JSON.parse(m.raw.toString('utf-8')) as unknown, raw: m.raw, digest: 'sha256:x', mediaType: m.mediaType };
});
const putManifest = jest.fn(async (name: string, ref: string, raw: Buffer, mediaType: string) => {
  manifests.set(`${name}:${ref}`, { raw, mediaType });
  return { digest: 'sha256:x' };
});
const uploadSmallBlob = jest.fn(async (name: string, digest: string, bytes: Buffer) => {
  blobs.set(`${name}@${digest}`, bytes);
});
const listRepositoriesUnderPrefix = jest.fn(async (prefix: string) =>
  [...new Set([...manifests.keys()].map((k) => k.slice(0, k.lastIndexOf(':'))))].filter((r) => r.startsWith(prefix)).sort());

jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  getManifest, putManifest, uploadSmallBlob, listRepositoriesUnderPrefix,
}));
jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock());

const {
  PUBLICATION_RECORD_PREFIX,
  recordRepository,
  writePublicationRecord,
  readPublicationOwners,
  publicRepositoriesOwnedBy,
  publicationOwner,
  _resetPublicationCache,
} = await import('../src/services/public-publications.js');

const EMPTY_DIGEST = `sha256:${createHash('sha256').update('{}').digest('hex')}`;

beforeEach(() => {
  jest.clearAllMocks();
  manifests.clear();
  blobs.clear();
  _resetPublicationCache();
});

describe('recordRepository', () => {
  it('maps public/<handle>/<name> into the registry-meta namespace', () => {
    expect(PUBLICATION_RECORD_PREFIX).toBe('registry-meta/publications/');
    expect(recordRepository('public/acme/scanner')).toBe('registry-meta/publications/acme/scanner');
  });

  it.each(['org-acme/scanner', 'system/scanner', 'publicx/acme/scanner'])('refuses a non-public repository %s', (repo) => {
    expect(() => recordRepository(repo)).toThrow(/Not a public repository/);
  });
});

describe('writePublicationRecord', () => {
  it('writes an OCI artifact manifest whose annotations carry the publisher org', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');

    const repo = 'registry-meta/publications/acme/scanner';
    // The empty config/layer blob is uploaded into the record repository first.
    expect(uploadSmallBlob).toHaveBeenCalledWith(repo, EMPTY_DIGEST, Buffer.from('{}'));
    expect(putManifest).toHaveBeenCalledWith(repo, 'owner', expect.any(Buffer), 'application/vnd.oci.image.manifest.v1+json');
    expect(uploadSmallBlob.mock.invocationCallOrder[0]).toBeLessThan(putManifest.mock.invocationCallOrder[0]);

    const manifest = JSON.parse(putManifest.mock.calls[0][2].toString('utf-8'));
    const empty = { mediaType: 'application/vnd.oci.empty.v1+json', digest: EMPTY_DIGEST, size: 2 };
    expect(manifest).toEqual({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.pipeline-builder.publication.v1',
      config: empty,
      layers: [empty],
      annotations: {
        'dev.pipeline-builder.repository': 'public/acme/scanner',
        'dev.pipeline-builder.publisher-org-id': 'org1',
      },
    });
  });

  it('is a no-op when the record already names the same org', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');
    jest.clearAllMocks();
    await writePublicationRecord('public/acme/scanner', 'org1');
    expect(uploadSmallBlob).not.toHaveBeenCalled();
    expect(putManifest).not.toHaveBeenCalled();
  });

  it('re-points the record on an ownership transfer', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');
    await writePublicationRecord('public/acme/scanner', 'org2');
    expect(await publicationOwner('public/acme/scanner')).toBe('org2');
  });

  it('records an unattributed publication (null → empty annotation → read back as null)', async () => {
    await writePublicationRecord('public/acme/scanner', null);
    const manifest = JSON.parse(putManifest.mock.calls[0][2].toString('utf-8'));
    expect(manifest.annotations['dev.pipeline-builder.publisher-org-id']).toBe('');
    const { owners } = await readPublicationOwners();
    expect(owners.get('public/acme/scanner')).toBeNull();
  });

  it('writes nothing when the existing record cannot be read (non-404)', async () => {
    getManifest.mockRejectedValueOnce(Object.assign(new Error('registry 500'), { statusCode: 500 }));
    await expect(writePublicationRecord('public/acme/scanner', 'org1')).rejects.toThrow('registry 500');
    expect(putManifest).not.toHaveBeenCalled();
  });

  it('refuses a non-public repository before touching the registry', async () => {
    await expect(writePublicationRecord('org-acme/scanner', 'acme')).rejects.toThrow(/Not a public repository/);
    expect(getManifest).not.toHaveBeenCalled();
  });
});

describe('readPublicationOwners', () => {
  it('reads every record back (write → read round trip)', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');
    await writePublicationRecord('public/acme/linter', 'org1');
    await writePublicationRecord('public/beta/tool', 'org2');
    const { owners, complete } = await readPublicationOwners({ force: true });
    expect(complete).toBe(true);
    expect(Object.fromEntries(owners)).toEqual({
      'public/acme/linter': 'org1',
      'public/acme/scanner': 'org1',
      'public/beta/tool': 'org2',
    });
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledWith('registry-meta/publications/');
  });

  it('derives the public repository from the record path when the annotation is missing', async () => {
    const raw = Buffer.from(JSON.stringify({ annotations: { 'dev.pipeline-builder.publisher-org-id': 'org9' } }));
    manifests.set('registry-meta/publications/gamma/thing:owner', { raw, mediaType: 'x' });
    const { owners } = await readPublicationOwners();
    expect(owners.get('public/gamma/thing')).toBe('org9');
  });

  it('treats a record with no annotations at all as unattributed', async () => {
    manifests.set('registry-meta/publications/gamma/thing:owner', { raw: Buffer.from('{}'), mediaType: 'x' });
    const { owners } = await readPublicationOwners();
    expect(owners.get('public/gamma/thing')).toBeNull();
  });

  it('skips a repository whose owner tag is gone (404) and stays complete', async () => {
    manifests.set('registry-meta/publications/acme/old:other', { raw: Buffer.from('{}'), mediaType: 'x' });
    await writePublicationRecord('public/acme/scanner', 'org1');
    const { owners, complete } = await readPublicationOwners({ force: true });
    expect(complete).toBe(true);
    expect([...owners.keys()]).toEqual(['public/acme/scanner']);
  });

  it('reports incomplete (and does not cache) when a record is unreadable', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');
    await writePublicationRecord('public/beta/tool', 'org2');
    getManifest.mockImplementationOnce(async () => { throw Object.assign(new Error('500'), { statusCode: 500 }); });
    const first = await readPublicationOwners({ force: true });
    expect(first.complete).toBe(false);
    // Not cached: the next read lists again and is complete.
    const second = await readPublicationOwners();
    expect(second.complete).toBe(true);
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(2);
  });

  it('caches a complete read; force bypasses; a write invalidates', async () => {
    await writePublicationRecord('public/acme/scanner', 'org1');
    await readPublicationOwners();
    await readPublicationOwners();
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(1);
    await readPublicationOwners({ force: true });
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(2);
    await writePublicationRecord('public/beta/tool', 'org2');
    const { owners } = await readPublicationOwners();
    expect(listRepositoriesUnderPrefix).toHaveBeenCalledTimes(3);
    expect(owners.get('public/beta/tool')).toBe('org2');
  });

  it('propagates a catalog failure', async () => {
    listRepositoriesUnderPrefix.mockRejectedValueOnce(new Error('catalog down'));
    await expect(readPublicationOwners()).rejects.toThrow('catalog down');
  });
});

describe('publicRepositoriesOwnedBy / publicationOwner', () => {
  beforeEach(async () => {
    await writePublicationRecord('public/acme/zeta', 'Org1');
    await writePublicationRecord('public/acme/alpha', 'org1');
    await writePublicationRecord('public/beta/tool', 'org2');
    await writePublicationRecord('public/nobody/x', null);
  });

  it('lists only the repositories billed to the org (case-insensitive), sorted', async () => {
    expect(await publicRepositoriesOwnedBy('ORG1')).toEqual({
      repositories: ['public/acme/alpha', 'public/acme/zeta'],
      complete: true,
    });
    expect((await publicRepositoriesOwnedBy('org2')).repositories).toEqual(['public/beta/tool']);
    expect((await publicRepositoriesOwnedBy('org3')).repositories).toEqual([]);
  });

  it('passes an incomplete read through so the push gate can fail closed', async () => {
    getManifest.mockImplementationOnce(async () => { throw Object.assign(new Error('500'), { statusCode: 500 }); });
    _resetPublicationCache();
    expect((await publicRepositoriesOwnedBy('org1')).complete).toBe(false);
  });

  it('names the billed org of one repository, or null', async () => {
    expect(await publicationOwner('public/beta/tool')).toBe('org2');
    expect(await publicationOwner('public/nobody/x')).toBeNull();
    expect(await publicationOwner('public/unknown/y')).toBeNull();
  });
});
