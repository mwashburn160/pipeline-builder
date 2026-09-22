// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for services/public-publishing — the registry side of the plugin
 * ecosystem's read-only `public/<handle>/<name>` namespace (§3.3 / §3.4):
 *
 *  - publish copies the approved digest's manifest + blobs (never its `.sig` /
 *    `.att`), signs it FRESH in `public/*` with the trust-tier + publisher
 *    annotations, re-attests the SBOM read from the SOURCE's signed attestation,
 *    and tags the version only after it is signed. A listed version is immutable.
 *  - resign replaces the signature's annotations and drops the verify cache.
 *  - yank removes the version TAG only (pipelines pull by digest).
 *  - gc deletes a digest only when no tag in the repository still resolves to it.
 *  - verify reads the signed annotations, caching only fully-verified results.
 *
 * The registry client and cosign (plugin-signing) are mocked; the REAL
 * manifest-copy runs over the mocked client so the copy is exercised as shipped.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';
import { registryClientMock } from './helpers/registry-client-mock.js';

type Manifest = { body: unknown; raw: Buffer; digest: string; mediaType: string };

const headManifest = jest.fn<(name: string, ref: string) => Promise<{ digest: string } | null>>();
const getManifest = jest.fn<(name: string, ref: string) => Promise<Manifest>>();
const putManifest = jest.fn<(name: string, ref: string, raw: Buffer, mediaType: string) => Promise<{ digest: string }>>();
const deleteManifest = jest.fn<(name: string, digest: string) => Promise<void>>();
const deleteTag = jest.fn<(name: string, tag: string) => Promise<void>>();
const listTags = jest.fn<(name: string) => Promise<{ name: string; tags: string[] }>>();
const mountBlob = jest.fn<(from: string, to: string, digest: string) => Promise<{ mounted: true }>>();
jest.unstable_mockModule('../src/services/registry-client.js', () => registryClientMock({
  headManifest, getManifest, putManifest, deleteManifest, deleteTag, listTags, mountBlob,
}));

class PluginSigningError extends Error {}
class CosignRejectedError extends PluginSigningError {}
type Sig = { dockerReference?: string; manifestDigest?: string; annotations: Record<string, string> };
const signPluginImage = jest.fn<(p: { repository: string; digest: string; sbom: unknown; annotations?: Record<string, string> }) => Promise<void>>();
const resignPublicImage = jest.fn<(repo: string, digest: string, annotations: Record<string, string>) => Promise<void>>();
const readSignedSbom = jest.fn<(repo: string, digest: string) => Promise<Record<string, unknown>>>();
const verifyPluginSignature = jest.fn<(repo: string, digest: string) => Promise<Sig[]>>();
jest.unstable_mockModule('../src/services/plugin-signing.js', () => ({
  PluginSigningError,
  CosignRejectedError,
  TRUST_ANNOTATION: 'pb.trust',
  PUBLISHER_ANNOTATION: 'pb.publisher',
  signPluginImage,
  resignPublicImage,
  readSignedSbom,
  verifyPluginSignature,
}));

const writePublicationRecord = jest.fn<(repo: string, org: string | null) => Promise<void>>();
const publicationOwner = jest.fn<(repo: string) => Promise<string | null>>();
jest.unstable_mockModule('../src/services/public-publications.js', () => ({ writePublicationRecord, publicationOwner }));

const invalidateStorageCache = jest.fn();
const invalidateOrgStorageCache = jest.fn();
jest.unstable_mockModule('../src/services/storage-usage.js', () => ({ invalidateStorageCache, invalidateOrgStorageCache }));

const incCounter = jest.fn();
const setGauge = jest.fn();
jest.unstable_mockModule('@pipeline-builder/api-server', () => stubModule('@pipeline-builder/api-server', { incCounter, setGauge }));
jest.unstable_mockModule('../src/config/index.js', () => ({ config: { registry: { host: 'registry', port: 5000 } } }));

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  runConcurrent: async <T>(items: T[], _n: number, fn: (t: T) => Promise<void>) => {
    for (const item of items) await fn(item);
  },
}));

const {
  publishPublicImage,
  resignPublicImageOp,
  reportResignProgress,
  yankPublicVersion,
  retagPublicVersion,
  gcPublicImage,
  verifyPublication,
  invalidateVerifyCache,
  PublicationConflictError,
  PublicationNotFoundError,
  SourceVerificationError,
  PublicationMetrics,
  TRUST_TIERS,
  _resetPublicPublishingState,
} = await import('../src/services/public-publishing.js');

const hex = (c: string) => c.repeat(64);
const DIGEST = `sha256:${hex('a')}`;
const OTHER = `sha256:${hex('b')}`;
const CFG = `sha256:${hex('c')}`;
const LAYER = `sha256:${hex('d')}`;
const SIG_DIGEST = `sha256:${hex('e')}`;
const ORG = '6650f0c3a1b2c3d4e5f60718';
const SOURCE = `org-${ORG}/scanner`;
const TARGET = 'public/acme/scanner';
const SBOM = { spdxVersion: 'SPDX-2.3', name: 'scanner' };
const OCI = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';

const sourceManifest = (): Manifest => {
  const body = { schemaVersion: 2, mediaType: OCI, config: { digest: CFG }, layers: [{ digest: LAYER }] };
  return { body, raw: Buffer.from(JSON.stringify(body)), digest: DIGEST, mediaType: OCI };
};

const publishParams = (over: Partial<Parameters<typeof publishPublicImage>[0]> = {}) => ({
  sourceRepository: SOURCE,
  digest: DIGEST,
  publisherHandle: 'acme',
  name: 'scanner',
  version: '1.2.0',
  tier: 'verified' as const,
  publisherOrgId: ORG,
  ...over,
});

const notFound = () => Object.assign(new Error('not found'), { response: { status: 404 } });

beforeEach(() => {
  jest.clearAllMocks();
  _resetPublicPublishingState();
  headManifest.mockResolvedValue(null);
  getManifest.mockResolvedValue(sourceManifest());
  putManifest.mockResolvedValue({ digest: DIGEST });
  deleteManifest.mockResolvedValue(undefined);
  deleteTag.mockResolvedValue(undefined);
  listTags.mockResolvedValue({ name: TARGET, tags: [] });
  mountBlob.mockResolvedValue({ mounted: true });
  signPluginImage.mockResolvedValue(undefined);
  resignPublicImage.mockResolvedValue(undefined);
  readSignedSbom.mockResolvedValue(SBOM);
  verifyPluginSignature.mockResolvedValue([]);
  writePublicationRecord.mockResolvedValue(undefined);
  publicationOwner.mockResolvedValue(ORG);
});

/** A verified signature made for TARGET@DIGEST with the given annotations. */
const sig = (annotations: Record<string, string>, over: Partial<Sig> = {}): Sig => ({
  dockerReference: `registry:5000/${TARGET}`,
  manifestDigest: DIGEST,
  annotations,
  ...over,
});

// -----------------------------------------------------------------------------
// publish
// -----------------------------------------------------------------------------

describe('publishPublicImage', () => {
  it('copies the digest, records the owner, signs fresh with tier + publisher annotations, then tags the version', async () => {
    const result = await publishPublicImage(publishParams());

    expect(result).toEqual({ imageRepository: TARGET, digest: DIGEST, alreadyPublished: false });

    // The source is read BY DIGEST from the publisher's private repository.
    expect(getManifest).toHaveBeenCalledWith(SOURCE, DIGEST);
    // Blobs are mounted (never re-uploaded) from source into public/*.
    expect(mountBlob).toHaveBeenCalledWith(SOURCE, TARGET, CFG);
    expect(mountBlob).toHaveBeenCalledWith(SOURCE, TARGET, LAYER);
    // The manifest lands in public/* by digest first (untagged)…
    const src = sourceManifest();
    expect(putManifest).toHaveBeenNthCalledWith(1, TARGET, DIGEST, src.raw, OCI);
    // …the ownership record names the publisher org (storage attribution)…
    expect(writePublicationRecord).toHaveBeenCalledWith(TARGET, ORG);
    // …the signature is made FOR public/* with the tier annotations, and the SBOM
    // re-attested is the one read from the SOURCE's signed attestation.
    expect(readSignedSbom).toHaveBeenCalledWith(SOURCE, DIGEST);
    expect(signPluginImage).toHaveBeenCalledWith({
      repository: TARGET,
      digest: DIGEST,
      sbom: SBOM,
      annotations: { 'pb.trust': 'verified', 'pb.publisher': 'acme' },
    });
    // …and only then is the version tag written.
    expect(putManifest).toHaveBeenNthCalledWith(2, TARGET, '1.2.0', src.raw, OCI);
    const tagPut = putManifest.mock.invocationCallOrder[1];
    expect(signPluginImage.mock.invocationCallOrder[0]).toBeLessThan(tagPut);
    expect(putManifest.mock.invocationCallOrder[0]).toBeLessThan(signPluginImage.mock.invocationCallOrder[0]);
  });

  it('never copies the source\'s cosign signature or attestation into public/*', async () => {
    await publishPublicImage(publishParams());
    const refs = [...getManifest.mock.calls, ...putManifest.mock.calls].map((c) => c[1]);
    expect(refs.some((r) => /\.(sig|att)$/.test(r))).toBe(false);
    // Nothing is copied under a cosign companion tag, and the source repository is
    // never written to.
    expect(putManifest.mock.calls.every((c) => c[0] === TARGET)).toBe(true);
  });

  it('refuses a digest that is not present in the source repository (404), signing and tagging nothing', async () => {
    getManifest.mockRejectedValue(notFound());
    const err = await publishPublicImage(publishParams()).catch((e) => e);
    expect(err).toBeInstanceOf(PublicationNotFoundError);
    expect(err.message).toContain(SOURCE);
    expect(mountBlob).not.toHaveBeenCalled();
    expect(signPluginImage).not.toHaveBeenCalled();
    expect(putManifest).not.toHaveBeenCalled();
    expect(writePublicationRecord).not.toHaveBeenCalled();
  });

  it('propagates a non-404 source read failure untyped', async () => {
    getManifest.mockRejectedValue(Object.assign(new Error('registry down'), { statusCode: 503 }));
    await expect(publishPublicImage(publishParams())).rejects.toThrow('registry down');
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it('refuses a re-publish of a listed version that points at a DIFFERENT digest (immutable, 409)', async () => {
    headManifest.mockImplementation(async (name, ref) => (name === TARGET && ref === '1.2.0' ? { digest: OTHER } : null));
    const err = await publishPublicImage(publishParams()).catch((e) => e);
    expect(err).toBeInstanceOf(PublicationConflictError);
    expect(err.message).toMatch(/immutable/);
    // Nothing was read, copied, signed, recorded or re-tagged.
    expect(getManifest).not.toHaveBeenCalled();
    expect(signPluginImage).not.toHaveBeenCalled();
    expect(putManifest).not.toHaveBeenCalled();
    expect(writePublicationRecord).not.toHaveBeenCalled();
  });

  it('is idempotent for the SAME digest: re-signs (repairing a half-done publish) without re-tagging', async () => {
    headManifest.mockImplementation(async (name, ref) => (name === TARGET && ref === '1.2.0' ? { digest: DIGEST } : null));
    const result = await publishPublicImage(publishParams());
    expect(result.alreadyPublished).toBe(true);
    expect(signPluginImage).toHaveBeenCalledTimes(1);
    // Only the by-digest copy is PUT — the version tag is not rewritten.
    expect(putManifest).toHaveBeenCalledTimes(1);
    expect(putManifest).toHaveBeenCalledWith(TARGET, DIGEST, expect.any(Buffer), OCI);
  });

  it('refuses a source with no platform-signed SBOM attestation (SourceVerificationError), copying nothing', async () => {
    readSignedSbom.mockRejectedValue(new CosignRejectedError('no attestation verifies'));
    const err = await publishPublicImage(publishParams()).catch((e) => e);
    expect(err).toBeInstanceOf(SourceVerificationError);
    expect(mountBlob).not.toHaveBeenCalled();
    expect(putManifest).not.toHaveBeenCalled();
    expect(signPluginImage).not.toHaveBeenCalled();
  });

  it('propagates an infrastructure failure reading the SBOM as-is (not a verification failure)', async () => {
    const infra = new PluginSigningError('cosign not found');
    readSignedSbom.mockRejectedValue(infra);
    await expect(publishPublicImage(publishParams())).rejects.toBe(infra);
  });

  it('never tags a version whose signing failed (a visible tag always has a signature)', async () => {
    signPluginImage.mockRejectedValue(new PluginSigningError('cosign sign failed'));
    await expect(publishPublicImage(publishParams())).rejects.toBeInstanceOf(PluginSigningError);
    expect(putManifest.mock.calls.map((c) => c[1])).toEqual([DIGEST]);
    expect(invalidateStorageCache).not.toHaveBeenCalled();
  });

  it('invalidates the public rollup and the publisher org\'s storage cache', async () => {
    await publishPublicImage(publishParams());
    expect(invalidateStorageCache).toHaveBeenCalledWith('public/');
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith(ORG);
  });

  it('records an unattributed (null-org) publication and touches no org cache', async () => {
    await publishPublicImage(publishParams({ sourceRepository: 'system/scanner', publisherOrgId: null }));
    expect(writePublicationRecord).toHaveBeenCalledWith(TARGET, null);
    expect(invalidateOrgStorageCache).not.toHaveBeenCalled();
  });

  it('copies a multi-arch index with its children', async () => {
    const child = `sha256:${hex('1')}`;
    const indexBody = { schemaVersion: 2, mediaType: INDEX, manifests: [{ digest: child }] };
    const index: Manifest = { body: indexBody, raw: Buffer.from(JSON.stringify(indexBody)), digest: DIGEST, mediaType: INDEX };
    getManifest.mockImplementation(async (_n, ref) => (ref === DIGEST ? index : { ...sourceManifest(), digest: child }));
    await publishPublicImage(publishParams());
    expect(putManifest.mock.calls.map((c) => c[1])).toEqual([child, DIGEST, '1.2.0']);
  });

  it('serializes operations on one repository (a second publish waits for the first)', async () => {
    let release!: () => void;
    signPluginImage.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const first = publishPublicImage(publishParams());
    // Let the first reach cosign.
    for (let i = 0; i < 20 && !release; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    const second = publishPublicImage(publishParams({ version: '1.3.0' }));
    await new Promise((r) => setImmediate(r));
    // The second hasn't even looked at the registry while the first is signing.
    expect(headManifest.mock.calls.filter((c) => c[1] === '1.3.0')).toHaveLength(0);
    release();
    await first;
    await second;
    expect(headManifest.mock.calls.filter((c) => c[1] === '1.3.0')).toHaveLength(1);
  });

  it('does not let a failed operation block the next one on the same repository', async () => {
    signPluginImage.mockRejectedValueOnce(new PluginSigningError('boom'));
    await expect(publishPublicImage(publishParams())).rejects.toThrow('boom');
    await expect(publishPublicImage(publishParams())).resolves.toMatchObject({ alreadyPublished: false });
  });
});

// -----------------------------------------------------------------------------
// resign
// -----------------------------------------------------------------------------

describe('resignPublicImageOp', () => {
  const params = { imageRepository: TARGET, digest: DIGEST, publisherHandle: 'acme', tier: 'official' as const };

  it('replaces the signature with the new tier + publisher annotations', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    await resignPublicImageOp(params);
    expect(headManifest).toHaveBeenCalledWith(TARGET, DIGEST);
    expect(resignPublicImage).toHaveBeenCalledWith(TARGET, DIGEST, { 'pb.trust': 'official', 'pb.publisher': 'acme' });
    // No transfer → the ownership record is untouched.
    expect(writePublicationRecord).not.toHaveBeenCalled();
    expect(invalidateStorageCache).toHaveBeenCalledWith('public/');
  });

  it('404s an image that is not in the public repository, signing nothing', async () => {
    headManifest.mockResolvedValue(null);
    await expect(resignPublicImageOp(params)).rejects.toBeInstanceOf(PublicationNotFoundError);
    expect(resignPublicImage).not.toHaveBeenCalled();
  });

  it('re-points storage attribution on an ownership transfer', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    await resignPublicImageOp({ ...params, publisherOrgId: 'neworg' });
    expect(writePublicationRecord).toHaveBeenCalledWith(TARGET, 'neworg');
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith('neworg');
    // The previous owner stops being billed immediately, not after its cache TTL.
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith(ORG);
  });

  it('can un-attribute a listing (publisherOrgId: null)', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    await resignPublicImageOp({ ...params, publisherOrgId: null });
    expect(writePublicationRecord).toHaveBeenCalledWith(TARGET, null);
  });

  it('invalidates the verify cache so the new tier is served immediately', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'community', 'pb.publisher': 'acme' })]);
    expect((await verifyPublication(TARGET, DIGEST)).tier).toBe('community');

    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' })]);
    // Still cached before the re-sign…
    expect((await verifyPublication(TARGET, DIGEST)).tier).toBe('community');
    await resignPublicImageOp(params);
    // …re-verified after it.
    expect((await verifyPublication(TARGET, DIGEST)).tier).toBe('official');
    expect(verifyPluginSignature).toHaveBeenCalledTimes(2);
  });
});

describe('reportResignProgress', () => {
  it('sets the completed / total / last-progress gauges', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_500);
    reportResignProgress({ completed: 3, total: 10 });
    expect(setGauge).toHaveBeenCalledWith(PublicationMetrics.RESIGN_JOB_COMPLETED, {}, 3);
    expect(setGauge).toHaveBeenCalledWith(PublicationMetrics.RESIGN_JOB_TOTAL, {}, 10);
    expect(setGauge).toHaveBeenCalledWith(PublicationMetrics.RESIGN_JOB_LAST_PROGRESS, {}, 1_700_000_000);
  });
});

// -----------------------------------------------------------------------------
// yank
// -----------------------------------------------------------------------------

describe('retagPublicVersion (unyank)', () => {
  it('puts the tag back on the digest from the public manifest alone', async () => {
    headManifest.mockResolvedValue(null);
    getManifest.mockResolvedValue(sourceManifest());
    expect(await retagPublicVersion(TARGET, '1.2.0', DIGEST)).toEqual({ alreadyTagged: false });
    expect(getManifest).toHaveBeenCalledWith(TARGET, DIGEST);
    expect(putManifest).toHaveBeenCalledWith(TARGET, '1.2.0', expect.any(Buffer), OCI);
    expect(invalidateStorageCache).toHaveBeenCalledWith('public/');
  });

  it('is idempotent when the tag already points at the digest', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    expect(await retagPublicVersion(TARGET, '1.2.0', DIGEST)).toEqual({ alreadyTagged: true });
    expect(putManifest).not.toHaveBeenCalled();
  });

  it('refuses a tag on a different digest (409) and a missing digest (404)', async () => {
    headManifest.mockResolvedValue({ digest: OTHER });
    await expect(retagPublicVersion(TARGET, '1.2.0', DIGEST)).rejects.toBeInstanceOf(PublicationConflictError);
    headManifest.mockResolvedValue(null);
    getManifest.mockRejectedValueOnce(Object.assign(new Error('nope'), { response: { status: 404 } }));
    await expect(retagPublicVersion(TARGET, '1.2.0', DIGEST)).rejects.toBeInstanceOf(PublicationNotFoundError);
    getManifest.mockRejectedValueOnce(new Error('boom'));
    await expect(retagPublicVersion(TARGET, '1.2.0', DIGEST)).rejects.toThrow('boom');
    expect(putManifest).not.toHaveBeenCalled();
  });
});

describe('yankPublicVersion', () => {
  it('removes ONLY the version tag — never the manifest or its blobs', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    expect(await yankPublicVersion(TARGET, '1.2.0', DIGEST)).toEqual({ alreadyYanked: false });
    expect(headManifest).toHaveBeenCalledWith(TARGET, '1.2.0');
    expect(deleteTag).toHaveBeenCalledWith(TARGET, '1.2.0');
    expect(deleteManifest).not.toHaveBeenCalled();
    expect(invalidateStorageCache).toHaveBeenCalledWith('public/');
  });

  it('is idempotent: an already-removed tag succeeds without deleting anything', async () => {
    headManifest.mockResolvedValue(null);
    expect(await yankPublicVersion(TARGET, '1.2.0', DIGEST)).toEqual({ alreadyYanked: true });
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it('refuses (409) when the tag points at a different digest than the caller named', async () => {
    headManifest.mockResolvedValue({ digest: OTHER });
    await expect(yankPublicVersion(TARGET, '1.2.0', DIGEST)).rejects.toBeInstanceOf(PublicationConflictError);
    expect(deleteTag).not.toHaveBeenCalled();
  });

  it('invalidates the verify cache for the yanked digest', async () => {
    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'verified', 'pb.publisher': 'acme' })]);
    await verifyPublication(TARGET, DIGEST);
    headManifest.mockResolvedValue({ digest: DIGEST });
    await yankPublicVersion(TARGET, '1.2.0', DIGEST);
    await verifyPublication(TARGET, DIGEST);
    expect(verifyPluginSignature).toHaveBeenCalledTimes(2);
  });
});

// -----------------------------------------------------------------------------
// gc
// -----------------------------------------------------------------------------

describe('gcPublicImage', () => {
  const sigTag = `sha256-${hex('a')}.sig`;
  const attTag = `sha256-${hex('a')}.att`;

  it('deletes an untagged digest and its cosign signature / attestation, re-attributing the freed bytes', async () => {
    headManifest.mockImplementation(async (_n, ref) => {
      if (ref === DIGEST) return { digest: DIGEST };
      if (ref === sigTag) return { digest: SIG_DIGEST };
      return null; // no attestation manifest
    });
    listTags.mockResolvedValue({ name: TARGET, tags: ['1.3.0', sigTag] });
    getManifest.mockResolvedValue({ ...sourceManifest(), digest: OTHER }); // 1.3.0 → another digest

    expect(await gcPublicImage(TARGET, DIGEST)).toEqual({ deleted: true });
    expect(deleteManifest).toHaveBeenCalledWith(TARGET, DIGEST);
    expect(deleteManifest).toHaveBeenCalledWith(TARGET, SIG_DIGEST);
    expect(deleteManifest).toHaveBeenCalledTimes(2);
    // Companion tags aren't treated as version tags (never fetched as images).
    expect(getManifest).not.toHaveBeenCalledWith(TARGET, sigTag);
    expect(headManifest).toHaveBeenCalledWith(TARGET, attTag);
    expect(publicationOwner).toHaveBeenCalledWith(TARGET);
    expect(invalidateOrgStorageCache).toHaveBeenCalledWith(ORG);
  });

  it('refuses (409) while any tag still resolves directly to the digest — yank first', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    listTags.mockResolvedValue({ name: TARGET, tags: ['1.2.0'] });
    getManifest.mockResolvedValue(sourceManifest()); // 1.2.0 → DIGEST
    const err = await gcPublicImage(TARGET, DIGEST).catch((e) => e);
    expect(err).toBeInstanceOf(PublicationConflictError);
    expect(err.message).toMatch(/still referenced by tag 1\.2\.0/);
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('refuses (409) while a tagged index still references the digest as a child', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    listTags.mockResolvedValue({ name: TARGET, tags: ['2.0.0'] });
    const indexBody = { manifests: [{ digest: DIGEST }] };
    getManifest.mockResolvedValue({ body: indexBody, raw: Buffer.from('{}'), digest: OTHER, mediaType: INDEX });
    await expect(gcPublicImage(TARGET, DIGEST)).rejects.toBeInstanceOf(PublicationConflictError);
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-deleted digest succeeds with deleted:false', async () => {
    headManifest.mockResolvedValue(null);
    expect(await gcPublicImage(TARGET, DIGEST)).toEqual({ deleted: false });
    expect(listTags).not.toHaveBeenCalled();
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('treats a repository with no tag list (404) as untagged', async () => {
    headManifest.mockImplementation(async (_n, ref) => (ref === DIGEST ? { digest: DIGEST } : null));
    listTags.mockRejectedValue(notFound());
    expect(await gcPublicImage(TARGET, DIGEST)).toEqual({ deleted: true });
  });

  it('skips a tag that disappears mid-scan (404) and still deletes', async () => {
    headManifest.mockImplementation(async (_n, ref) => (ref === DIGEST ? { digest: DIGEST } : null));
    listTags.mockResolvedValue({ name: TARGET, tags: ['gone'] });
    getManifest.mockRejectedValue(notFound());
    expect(await gcPublicImage(TARGET, DIGEST)).toEqual({ deleted: true });
  });

  it('fails closed (deletes nothing) when the tag scan cannot be completed', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    listTags.mockResolvedValue({ name: TARGET, tags: ['1.2.0'] });
    getManifest.mockRejectedValue(Object.assign(new Error('registry 500'), { statusCode: 500 }));
    await expect(gcPublicImage(TARGET, DIGEST)).rejects.toThrow('registry 500');
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('fails closed when the tag list itself errors (non-404)', async () => {
    headManifest.mockResolvedValue({ digest: DIGEST });
    listTags.mockRejectedValue(Object.assign(new Error('catalog 500'), { statusCode: 500 }));
    await expect(gcPublicImage(TARGET, DIGEST)).rejects.toThrow('catalog 500');
    expect(deleteManifest).not.toHaveBeenCalled();
  });

  it('tolerates a companion that vanished between HEAD and DELETE, and an unreadable owner record', async () => {
    headManifest.mockImplementation(async (_n, ref) => (ref === DIGEST ? { digest: DIGEST } : { digest: SIG_DIGEST }));
    deleteManifest.mockImplementation(async (_n, d) => {
      if (d === SIG_DIGEST) throw notFound();
    });
    publicationOwner.mockRejectedValue(new Error('records unreadable'));
    expect(await gcPublicImage(TARGET, DIGEST)).toEqual({ deleted: true });
    expect(invalidateOrgStorageCache).not.toHaveBeenCalled();
    expect(invalidateStorageCache).toHaveBeenCalledWith('public/');
  });

  it('surfaces a non-404 companion delete failure', async () => {
    headManifest.mockImplementation(async (_n, ref) => (ref === DIGEST ? { digest: DIGEST } : { digest: SIG_DIGEST }));
    deleteManifest.mockImplementation(async (_n, d) => {
      if (d === SIG_DIGEST) throw Object.assign(new Error('delete 500'), { statusCode: 500 });
    });
    await expect(gcPublicImage(TARGET, DIGEST)).rejects.toThrow('delete 500');
  });
});

// -----------------------------------------------------------------------------
// verify + cache
// -----------------------------------------------------------------------------

describe('verifyPublication', () => {
  it('returns the signed tier + publisher and caches the verified result', async () => {
    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'verified', 'pb.publisher': 'acme' })]);
    const want = { signed: true, tier: 'verified', publisher: 'acme' };
    expect(await verifyPublication(TARGET, DIGEST)).toEqual(want);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual(want);
    expect(verifyPluginSignature).toHaveBeenCalledTimes(1);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.VERIFY, { result: 'signed', cache: 'miss' });
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.VERIFY, { result: 'signed', cache: 'hit' });
  });

  it('reports unsigned, and does not cache it (a later publish must be seen at once)', async () => {
    verifyPluginSignature.mockResolvedValue([]);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual({ signed: false, tier: null, publisher: null });
    await verifyPublication(TARGET, DIGEST);
    expect(verifyPluginSignature).toHaveBeenCalledTimes(2);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.VERIFY, { result: 'unsigned', cache: 'miss' });
  });

  it('ignores signatures made for ANOTHER repository (a copied signature does not count)', async () => {
    verifyPluginSignature.mockResolvedValue([
      sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }, { dockerReference: `registry:5000/${SOURCE}` }),
    ]);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual({ signed: false, tier: null, publisher: null });
  });

  it('matches the reference exactly, so a nested path ending in the repository does not count', async () => {
    verifyPluginSignature.mockResolvedValue([
      sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }, { dockerReference: `registry:5000/org-x/${TARGET}` }),
      sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }, { dockerReference: `evil:5000/${TARGET}` }),
    ]);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual({ signed: false, tier: null, publisher: null });
  });

  it('ignores signatures made for another digest', async () => {
    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }, { manifestDigest: OTHER })]);
    expect((await verifyPublication(TARGET, DIGEST)).signed).toBe(false);
  });

  it('accepts a bare-repository docker-reference and a payload without critical fields', async () => {
    verifyPluginSignature.mockResolvedValue([
      sig({ 'pb.trust': 'community', 'pb.publisher': 'acme' }, { dockerReference: TARGET }),
      { annotations: { 'pb.trust': 'community', 'pb.publisher': 'acme' } },
    ]);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual({ signed: true, tier: 'community', publisher: 'acme' });
  });

  it.each([
    ['disagreeing tiers', [sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }), sig({ 'pb.trust': 'community', 'pb.publisher': 'acme' })]],
    ['disagreeing publishers', [sig({ 'pb.trust': 'official', 'pb.publisher': 'acme' }), sig({ 'pb.trust': 'official', 'pb.publisher': 'evil' })]],
    ['a missing tier annotation', [sig({ 'pb.publisher': 'acme' })]],
    ['a missing publisher annotation', [sig({ 'pb.trust': 'official' })]],
    ['an unknown tier value', [sig({ 'pb.trust': 'platinum', 'pb.publisher': 'acme' })]],
  ])('refuses to pick a tier on %s (signed, tier null) and does not cache it', async (_label, sigs) => {
    verifyPluginSignature.mockResolvedValue(sigs);
    expect(await verifyPublication(TARGET, DIGEST)).toEqual({ signed: true, tier: null, publisher: null });
    await verifyPublication(TARGET, DIGEST);
    expect(verifyPluginSignature).toHaveBeenCalledTimes(2);
    expect(incCounter).toHaveBeenCalledWith(PublicationMetrics.VERIFY, { result: 'mismatch', cache: 'miss' });
  });

  it('re-verifies once the cache TTL has lapsed', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    verifyPluginSignature.mockResolvedValue([sig({ 'pb.trust': 'verified', 'pb.publisher': 'acme' })]);
    await verifyPublication(TARGET, DIGEST);
    now.mockReturnValue(1_000_000 + 60_001);
    await verifyPublication(TARGET, DIGEST);
    expect(verifyPluginSignature).toHaveBeenCalledTimes(2);
  });

  it('propagates an infrastructure failure (cosign unavailable)', async () => {
    verifyPluginSignature.mockRejectedValue(new PluginSigningError('cosign missing'));
    await expect(verifyPublication(TARGET, DIGEST)).rejects.toBeInstanceOf(PluginSigningError);
  });

  it('bounds the cache: at capacity it is flushed rather than grown', async () => {
    verifyPluginSignature.mockImplementation(async (repo, d) => [{
      dockerReference: repo, manifestDigest: d, annotations: { 'pb.trust': 'verified', 'pb.publisher': 'acme' },
    }]);
    for (let i = 0; i < 5000; i++) await verifyPublication(`public/acme/p${i}`, DIGEST);
    // Full: the next insert clears everything first, so exactly one entry remains.
    await verifyPublication('public/acme/overflow', DIGEST);
    expect(invalidateVerifyCache()).toBe(1);
  });
});

describe('invalidateVerifyCache', () => {
  const prime = async () => {
    verifyPluginSignature.mockImplementation(async (repo, d) => [{
      dockerReference: repo, manifestDigest: d, annotations: { 'pb.trust': 'verified', 'pb.publisher': 'acme' },
    }]);
    await verifyPublication(TARGET, DIGEST);
    await verifyPublication(TARGET, OTHER);
    await verifyPublication('public/acme/other', DIGEST);
  };

  it('drops one image', async () => {
    await prime();
    expect(invalidateVerifyCache(TARGET, DIGEST)).toBe(1);
    expect(invalidateVerifyCache(TARGET, DIGEST)).toBe(0);
    expect(invalidateVerifyCache()).toBe(2);
  });

  it('drops every digest of one repository, leaving other repositories', async () => {
    await prime();
    expect(invalidateVerifyCache(TARGET)).toBe(2);
    expect(invalidateVerifyCache()).toBe(1);
  });

  it('does not treat a repository-name prefix as the same repository', async () => {
    await prime();
    expect(invalidateVerifyCache('public/acme/scan')).toBe(0);
  });

  it('drops everything', async () => {
    await prime();
    expect(invalidateVerifyCache()).toBe(3);
    expect(invalidateVerifyCache()).toBe(0);
  });
});

describe('exports', () => {
  it('names the four trust tiers in order', () => {
    expect(TRUST_TIERS).toEqual(['official', 'verified', 'community', 'unverified']);
  });
});
