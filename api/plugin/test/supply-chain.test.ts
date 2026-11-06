// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for helpers/supply-chain: the SBOM + signing request after a push, and
 * the signature / SBOM verification the lookup + SBOM routes rely on.
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { stubModule } from '@pipeline-builder/api-core/testing';
import { apiCoreMock } from './helpers/mock-api-core.js';

const DIGEST = `sha256:${'e'.repeat(64)}`;
const REGISTRY = { host: 'registry', port: 5000, network: '', http: true };

/** Child that prints `stdout` then exits with `exitCode`. */
function child(exitCode = 0, stdout = ''): any {
  const c = new EventEmitter();
  const out = new EventEmitter();
  const err = new EventEmitter();
  Object.assign(c, { stdout: out, stderr: err, kill: () => {} });
  process.nextTick(() => {
    if (stdout) out.emit('data', Buffer.from(stdout));
    c.emit('close', exitCode);
  });
  return c;
}

const mockSpawn = jest.fn<(cmd: string, args: string[], opts?: any) => any>(() => child(0));
jest.unstable_mockModule('child_process', () => ({ spawn: mockSpawn }));

const mockExistsSync = jest.fn<(p: string) => boolean>(() => true);
const SBOM_JSON = JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [] });
/**
 * Mirrors the real `readFileSync` contract: a Buffer with no encoding, a string
 * with one. The SBOM is now read as BYTES (it is sent as the request body
 * verbatim), so a mock that always answered a string would make the production
 * code look like it was sending a JSON envelope when it is not.
 */
const mockReadFileSync = jest.fn<(p: string, enc?: string) => string | Buffer>(
  (_p, enc) => (enc ? SBOM_JSON : Buffer.from(SBOM_JSON)));
const mockRmSync = jest.fn();
jest.unstable_mockModule('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: jest.fn(),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}XXXX`),
  rmSync: mockRmSync,
  // The SBOM's SIZE is now measured before it is sent — it decides whether the
  // registry will accept it at all, and it was recorded nowhere. An `fs` mock
  // that omits an export the code reaches for fails the whole module, so it is
  // listed here rather than discovered at runtime.
  statSync: jest.fn(() => ({ size: 4096 })),
}));

const mockPost = jest.fn<(path: string, body: unknown, opts?: any) => Promise<{ statusCode: number; body: any }>>(
  async () => ({ statusCode: 200, body: { signed: true } }));
const mockClientCtor = jest.fn();
class InternalHttpClient {
  constructor(cfg: unknown) { mockClientCtor(cfg); }
  post = mockPost;
}

jest.unstable_mockModule('@pipeline-builder/api-core', () => apiCoreMock({
  InternalHttpClient,
  getServiceAuthHeader: jest.fn(() => 'Bearer svc-token'),
  signServiceToken: jest.fn(() => 'pull-token'),
}));

const mockConfigGet = (section: string): unknown => {
  if (section === 'dockerConfig') {
    return {
      tempRoot: '/data/build',
      timeoutMs: 900000,
      pushTimeoutMs: 300000,
      buildkitAddr: 'unix:///run/buildkit/buildkitd.sock',
      signingPublicKeyFile: '/etc/pipeline-builder/plugin-signing/plugin-signing.pub',
    };
  }
  if (section === 'server') return { services: { imageRegistryHost: 'image-registry', imageRegistryPort: 3000 } };
  return {};
};
jest.unstable_mockModule('@pipeline-builder/pipeline-core', () => stubModule('@pipeline-builder/pipeline-core', {
  Config: { get: mockConfigGet, getAny: mockConfigGet },
}));

const {
  attachSupplyChain,
  discardPluginImage,
  verifyImageSignature,
  fetchImageSbom,
  extractSpdxPredicate,
  fetchPublicImageSbom,
  ImageVerificationError,
  SbomBusyError,
  _resetSupplyChainState,
  _resetPublicSbomCache,
} = await import('../src/helpers/supply-chain.js');

const plugin = { orgId: 'acme', name: 'foo', imageDigest: DIGEST };

/** One DSSE envelope line as `cosign verify-attestation` prints it. */
function envelope(predicateType: string, predicate: unknown): string {
  const statement = { _type: 'https://in-toto.io/Statement/v0.1', predicateType, predicate };
  return JSON.stringify({ payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(statement)).toString('base64') });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpawn.mockImplementation(() => child(0));
  mockExistsSync.mockReturnValue(true);
  _resetSupplyChainState();
  _resetPublicSbomCache();
});

describe('attachSupplyChain', () => {
  const params = {
    repository: 'registry:5000/org-acme/foo',
    digest: DIGEST,
    registry: REGISTRY,
    orgId: 'acme',
    dockerConfigDir: '/tmp/pb-dockercfg-x',
  };

  it('scans the pushed digest with syft, then asks image-registry to sign + attest it', async () => {
    await attachSupplyChain({ ...params, platform: 'linux/amd64' });

    const [binary, args, opts] = mockSpawn.mock.calls[0];
    expect(binary).toBe('syft');
    expect(args).toEqual(expect.arrayContaining(['scan', `registry:registry:5000/org-acme/foo@${DIGEST}`, '--platform', 'linux/amd64']));
    expect(args.some((a) => a.startsWith('spdx-json='))).toBe(true);
    expect(opts.env).toEqual(expect.objectContaining({
      DOCKER_CONFIG: '/tmp/pb-dockercfg-x',
      SYFT_REGISTRY_INSECURE_USE_HTTP: 'true',
      SYFT_CHECK_FOR_APP_UPDATE: 'false',
    }));

    expect(mockClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: 'image-registry', port: 3000 }));
    // The SBOM is the raw BODY, with its metadata in headers: the registry can
    // then validate the repository and digest before reading a byte, and stream
    // the document straight to the file cosign attests from. Sending it inside a
    // JSON envelope meant parsing it here only for the client to serialize it
    // back — two full copies of a document that was already on disk.
    const [sentPath, sentBody, sentOpts] = mockPost.mock.calls[0]!;
    expect(sentPath).toBe('/internal/plugin-signatures');
    expect(Buffer.isBuffer(sentBody)).toBe(true);
    expect(JSON.parse(String(sentBody))).toEqual({ spdxVersion: 'SPDX-2.3', packages: [] });
    expect(sentOpts).toEqual(expect.objectContaining({
      headers: {
        'Authorization': 'Bearer svc-token',
        'x-pb-repository': 'org-acme/foo',
        'x-pb-digest': DIGEST,
      },
      maxRetries: 0,
    }));
  });

  it('never signs locally — this pod holds no private key and runs no cosign sign', async () => {
    await attachSupplyChain(params);
    expect(mockSpawn.mock.calls.map((c) => c[0])).toEqual(['syft']);
  });

  it('fails when image-registry refuses to sign', async () => {
    mockPost.mockResolvedValueOnce({ statusCode: 502, body: { message: 'cosign sign failed' } });
    await expect(attachSupplyChain(params)).rejects.toThrow(/refused to sign .*HTTP 502.*cosign sign failed/);
  });

  it('fails (and asks for no signature) when the SBOM scan fails', async () => {
    mockSpawn.mockImplementation(() => child(1));
    await expect(attachSupplyChain(params)).rejects.toThrow(/syft failed/);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses a malformed digest', async () => {
    await expect(attachSupplyChain({ ...params, digest: 'sha256:nope' })).rejects.toThrow(/malformed digest/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('discardPluginImage (a build the gates refused)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('asks image-registry to delete the namespace-relative image with a service token for the owning org', async () => {
    mockPost.mockResolvedValueOnce({ statusCode: 200, body: { data: { deleted: 3 } } });
    await expect(discardPluginImage({ repository: 'registry:5000/org-acme/foo', digest: DIGEST, registry: REGISTRY, orgId: 'acme' }))
      .resolves.toEqual({ deleted: 3 });
    expect(mockClientCtor).toHaveBeenCalledWith(expect.objectContaining({ host: 'image-registry', port: 3000 }));
    expect(mockPost).toHaveBeenCalledWith('/internal/plugin-images/discard', { repository: 'org-acme/foo', digest: DIGEST },
      expect.objectContaining({ headers: { Authorization: 'Bearer svc-token' } }));
  });

  it('throws on a refusal and on a malformed digest (the caller treats it as best-effort)', async () => {
    mockPost.mockResolvedValueOnce({ statusCode: 403, body: { message: 'not owned' } });
    await expect(discardPluginImage({ repository: 'registry:5000/org-acme/foo', digest: DIGEST, registry: REGISTRY, orgId: 'acme' }))
      .rejects.toThrow(/HTTP 403.*not owned/);
    await expect(discardPluginImage({ repository: 'registry:5000/org-acme/foo', digest: 'latest', registry: REGISTRY, orgId: 'acme' }))
      .rejects.toThrow(/malformed digest/);
  });
});

describe('verifyImageSignature', () => {
  it('runs cosign verify against the public key, by digest, with the tlog off', async () => {
    await verifyImageSignature(plugin, REGISTRY);
    const [binary, args] = mockSpawn.mock.calls[0];
    expect(binary).toBe('cosign');
    expect(args).toEqual([
      'verify', '--key', '/etc/pipeline-builder/plugin-signing/plugin-signing.pub',
      '--new-bundle-format=false', '--insecure-ignore-tlog=true',
      '--allow-insecure-registry', '--allow-http-registry',
      `registry:5000/org-acme/foo@${DIGEST}`,
    ]);
  });

  it('caches a verified digest (one cosign run for repeated lookups)', async () => {
    await verifyImageSignature(plugin, REGISTRY);
    await verifyImageSignature(plugin, REGISTRY);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('shares one cosign run across concurrent lookups', async () => {
    await Promise.all([verifyImageSignature(plugin, REGISTRY), verifyImageSignature(plugin, REGISTRY)]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('turns a cosign rejection into ImageVerificationError, and does not cache it', async () => {
    mockSpawn.mockImplementation(() => child(1));
    await expect(verifyImageSignature(plugin, REGISTRY)).rejects.toBeInstanceOf(ImageVerificationError);
    mockSpawn.mockImplementation(() => child(0));
    await verifyImageSignature(plugin, REGISTRY);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('refuses a plugin with no digest without running cosign', async () => {
    await expect(verifyImageSignature({ ...plugin, imageDigest: null }, REGISTRY)).rejects.toBeInstanceOf(ImageVerificationError);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('reports a missing public key as an infrastructure error, not a bad signature', async () => {
    mockExistsSync.mockReturnValue(false);
    const err = await verifyImageSignature(plugin, REGISTRY).catch((e) => e);
    expect(err).not.toBeInstanceOf(ImageVerificationError);
    expect(err.message).toMatch(/public key not found/);
  });

  it('removes the pull credential afterwards', async () => {
    await verifyImageSignature(plugin, REGISTRY);
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('pb-dockercfg-'), expect.objectContaining({ recursive: true }));
  });
});

describe('fetchImageSbom / extractSpdxPredicate', () => {
  const spdx = { spdxVersion: 'SPDX-2.3', name: 'foo' };

  it('returns the SPDX predicate from the verified attestation', async () => {
    mockSpawn.mockImplementation(() => child(0, `${envelope('https://spdx.dev/Document', spdx)}\n`));
    await expect(fetchImageSbom(plugin, REGISTRY)).resolves.toEqual(spdx);
    expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['verify-attestation', '--type', 'spdxjson']));
  });

  it('turns a failed attestation verification into ImageVerificationError', async () => {
    mockSpawn.mockImplementation(() => child(1));
    await expect(fetchImageSbom(plugin, REGISTRY)).rejects.toBeInstanceOf(ImageVerificationError);
  });

  it('picks the LAST SPDX attestation and ignores other predicate types', () => {
    const out = [
      envelope('https://spdx.dev/Document', { spdxVersion: 'SPDX-2.3', name: 'old' }),
      envelope('https://slsa.dev/provenance/v0.2', { builder: {} }),
      envelope('https://spdx.dev/Document', { spdxVersion: 'SPDX-2.3', name: 'new' }),
      'not json',
    ].join('\n');
    expect(extractSpdxPredicate(out, 'foo')).toEqual({ spdxVersion: 'SPDX-2.3', name: 'new' });
  });

  it('throws when there is no SPDX attestation at all', () => {
    expect(() => extractSpdxPredicate(envelope('https://slsa.dev/provenance/v0.2', {}), 'foo'))
      .toThrow(ImageVerificationError);
  });
});

describe('fetchPublicImageSbom (anonymous directory)', () => {
  const spdx = { spdxVersion: 'SPDX-2.3', name: 'trivy' };
  const ok = () => child(0, `${envelope('https://spdx.dev/Document', spdx)}\n`);

  it('verifies the attestation of the public/* image by digest and returns its SBOM', async () => {
    mockSpawn.mockImplementation(ok);
    await expect(fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY)).resolves.toEqual(spdx);
    const args = mockSpawn.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining([
      'verify-attestation', '--type', 'spdxjson', '--new-bundle-format=false', '--insecure-ignore-tlog=true',
    ]));
    expect(args[args.length - 1]).toBe(`registry:5000/public/acme/trivy@${DIGEST}`);
    // The pull credential is written and removed again.
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('pb-dockercfg-'), expect.objectContaining({ recursive: true }));
  });

  it('caches by digest: a second request runs no cosign', async () => {
    mockSpawn.mockImplementation(ok);
    await fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY);
    await fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('shares one cosign run between concurrent requests for the same image', async () => {
    mockSpawn.mockImplementation(ok);
    await Promise.all([
      fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY),
      fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY),
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('refuses a third distinct concurrent verification with SbomBusyError', async () => {
    mockSpawn.mockImplementation(ok);
    const d = (c: string) => `sha256:${c.repeat(64)}`;
    const first = fetchPublicImageSbom('public/acme/a', d('1'), REGISTRY);
    const second = fetchPublicImageSbom('public/acme/b', d('2'), REGISTRY);
    await expect(fetchPublicImageSbom('public/acme/c', d('3'), REGISTRY)).rejects.toBeInstanceOf(SbomBusyError);
    await Promise.all([first, second]);
    // Capacity frees up once they finish.
    await expect(fetchPublicImageSbom('public/acme/c', d('3'), REGISTRY)).resolves.toEqual(spdx);
  });

  it('does not cache a failure', async () => {
    mockSpawn.mockImplementationOnce(() => child(1)).mockImplementation(ok);
    await expect(fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY)).rejects.toBeInstanceOf(ImageVerificationError);
    await expect(fetchPublicImageSbom('public/acme/trivy', DIGEST, REGISTRY)).resolves.toEqual(spdx);
  });

  it.each([
    ['org-acme/trivy', DIGEST],
    ['public/acme/../system/x', DIGEST],
    ['public/acme/trivy', 'latest'],
  ])('refuses a non-public repository or a non-digest (%s @ %s) before running cosign', async (repo, digest) => {
    await expect(fetchPublicImageSbom(repo, digest, REGISTRY)).rejects.toBeInstanceOf(ImageVerificationError);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
