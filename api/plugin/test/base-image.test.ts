// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * helpers/base-image — the base image's `created` time recorded on a listed
 * version (its freshness): reference parsing, provenance
 * materials, which base is chosen, where it is read from, and that every
 * failure is a quiet null.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockRun = jest.fn<(cmd: string, args: string[], ...rest: unknown[]) => Promise<string>>();
jest.unstable_mockModule('../src/helpers/build-process.js', () => ({ run: mockRun }));
const mockWriteAuth = jest.fn((..._args: unknown[]) => '/tmp/pb-dockercfg-test');
jest.unstable_mockModule('../src/helpers/registry-auth.js', () => ({
  writeAuthConfig: mockWriteAuth,
  imageRepository: (name: string, r: { host: string; port: number }, orgId?: string) => `${r.host}:${r.port}/${orgId ? `org-${orgId}` : 'system'}/${name}`,
}));

const {
  baseImageLocations, configCreatedAt, parseImageRef, provenanceImageMaterials, resolveBaseImageCreatedAt, selectBaseImageRef,
} = await import('../src/helpers/base-image.js');

const REGISTRY = { host: 'registry', port: 5000, network: '', http: true };
const HEX = 'd'.repeat(64);
const DIGEST = `sha256:${HEX}`;
const IMG = `sha256:${'e'.repeat(64)}`;
const ATT = `sha256:${'f'.repeat(64)}`;
const LAYER = `sha256:${'1'.repeat(64)}`;

beforeEach(() => {
  mockRun.mockReset();
  mockWriteAuth.mockClear();
});

describe('parseImageRef', () => {
  it('splits host, path, tag and digest; Docker Hub hosts normalize to null', () => {
    expect(parseImageRef('alpine')).toEqual({ host: null, path: 'alpine', tag: null, digest: null });
    expect(parseImageRef('pipeline-plugin-base:24.04')).toEqual({ host: null, path: 'pipeline-plugin-base', tag: '24.04', digest: null });
    expect(parseImageRef(`docker.io/library/ubuntu:24.04@${DIGEST}`)).toEqual({ host: null, path: 'library/ubuntu', tag: '24.04', digest: DIGEST });
    expect(parseImageRef('registry:5000/library/x:1')).toEqual({ host: 'registry:5000', path: 'library/x', tag: '1', digest: null });
    expect(parseImageRef('public.ecr.aws/docker/library/ubuntu:24.04')).toMatchObject({ host: 'public.ecr.aws', path: 'docker/library/ubuntu' });
  });

  it('rejects build arguments, whitespace and bad digests', () => {
    expect(parseImageRef('node:${V}')).toBeNull();
    expect(parseImageRef('a b')).toBeNull();
    expect(parseImageRef('alpine@sha256:xyz')).toBeNull();
    expect(parseImageRef('')).toBeNull();
  });
});

describe('provenanceImageMaterials', () => {
  it('reads docker purls with a digest (v0.2 materials), skipping the Dockerfile frontend', () => {
    expect(provenanceImageMaterials({
      predicate: {
        materials: [
          { uri: 'pkg:docker/docker/dockerfile@1.7?platform=linux%2Famd64', digest: { sha256: HEX } },
          { uri: 'pkg:docker/pipeline-plugin-base@24.04?platform=linux%2Famd64', digest: { sha256: HEX } },
          { uri: 'pkg:docker/registry%3A5000/library/x@1', digest: { sha256: HEX } },
          { uri: 'https://github.com/x', digest: { sha1: 'abc' } },
          { uri: 'pkg:docker/no-digest@1' },
        ],
      },
    })).toEqual([
      { name: 'pipeline-plugin-base', digest: DIGEST },
      { name: 'registry:5000/library/x', digest: DIGEST },
    ]);
  });

  it('reads SLSA v1 resolvedDependencies, and is empty for anything else', () => {
    expect(provenanceImageMaterials({ predicate: { buildDefinition: { resolvedDependencies: [{ uri: 'pkg:docker/alpine@3', digest: { sha256: HEX } }] } } }))
      .toEqual([{ name: 'alpine', digest: DIGEST }]);
    expect(provenanceImageMaterials(null)).toEqual([]);
    expect(provenanceImageMaterials({ predicate: 'x' })).toEqual([]);
  });
});

describe('selectBaseImageRef', () => {
  const mats = [{ name: 'golang', digest: DIGEST }, { name: 'docker.io/library/ubuntu', digest: IMG }];

  it('pins the material matching the Dockerfile base by name', () => {
    expect(selectBaseImageRef('ubuntu:24.04', mats)).toBe(`docker.io/library/ubuntu@${IMG}`);
    expect(selectBaseImageRef('golang:1.23', mats)).toBe(`golang@${DIGEST}`);
  });

  it('takes the only material when the Dockerfile base is unknown, else falls back to the Dockerfile ref', () => {
    expect(selectBaseImageRef(null, [mats[0]!])).toBe(`golang@${DIGEST}`);
    expect(selectBaseImageRef(null, mats)).toBeNull();
    expect(selectBaseImageRef('alpine:3.20', mats)).toBe('alpine:3.20');
    expect(selectBaseImageRef('alpine:3.20', [])).toBe('alpine:3.20');
  });
});

describe('baseImageLocations', () => {
  it('reads Docker Hub names through the in-cluster mirror first, then upstream', () => {
    expect(baseImageLocations('pipeline-plugin-base:24.04', REGISTRY)).toEqual([
      'registry:5000/library/pipeline-plugin-base:24.04', 'docker.io/library/pipeline-plugin-base:24.04',
    ]);
    expect(baseImageLocations(`sonarsource/scanner@${DIGEST}`, REGISTRY)).toEqual([
      `registry:5000/sonarsource/scanner@${DIGEST}`, `docker.io/sonarsource/scanner@${DIGEST}`,
    ]);
    expect(baseImageLocations('alpine', REGISTRY)).toEqual(['registry:5000/library/alpine:latest', 'docker.io/library/alpine:latest']);
  });

  it('reads any other registry as written', () => {
    expect(baseImageLocations('public.ecr.aws/docker/library/ubuntu:24.04', REGISTRY)).toEqual(['public.ecr.aws/docker/library/ubuntu:24.04']);
    expect(baseImageLocations('$X', REGISTRY)).toEqual([]);
  });
});

describe('configCreatedAt', () => {
  it('parses `created`, treating the epoch and garbage as unknown', () => {
    expect(configCreatedAt('{"created":"2026-08-01T00:00:00Z"}')).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(configCreatedAt('{"created":"1970-01-01T00:00:00Z"}')).toBeNull();
    expect(configCreatedAt('{"created":"nope"}')).toBeNull();
    expect(configCreatedAt('{}')).toBeNull();
    expect(configCreatedAt('not json')).toBeNull();
  });
});

describe('resolveBaseImageCreatedAt', () => {
  const source = (over: Record<string, unknown> = {}) => ({
    orgId: 'acme', name: 'lint', imageDigest: IMG, imageSource: 'built', dockerfile: 'FROM pipeline-plugin-base:24.04\nRUN true', ...over,
  });

  it('follows the provenance to the digest-pinned base and reads its config', async () => {
    mockRun.mockImplementation(async (_cmd, args) => {
      const ref = args[args.length - 1]!;
      if (args.includes('manifest') && ref.endsWith(IMG)) {
        return JSON.stringify({ manifests: [{ digest: IMG }, { digest: ATT, annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }] });
      }
      if (args.includes('manifest') && ref.endsWith(ATT)) {
        return JSON.stringify({ layers: [{ digest: LAYER, annotations: { 'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v0.2' } }] });
      }
      if (args.includes('blob')) {
        return JSON.stringify({ predicate: { materials: [{ uri: 'pkg:docker/pipeline-plugin-base@24.04?platform=linux%2Famd64', digest: { sha256: HEX } }] } });
      }
      if (args.includes('config')) return JSON.stringify({ created: '2026-07-04T00:00:00Z' });
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(await resolveBaseImageCreatedAt(source(), REGISTRY)).toEqual(new Date('2026-07-04T00:00:00Z'));
    const config = mockRun.mock.calls.find((c) => c[1].includes('config'))!;
    expect(config[1]).toEqual(['--insecure', 'config', '--platform', 'linux/amd64', `registry:5000/library/pipeline-plugin-base@${DIGEST}`]);
    // A pull credential, never push.
    expect(mockWriteAuth).toHaveBeenCalledWith(REGISTRY, 'acme', expect.any(Number), 'pull');
  });

  it('falls back to the Dockerfile base (mirror, then upstream) for an uploaded image', async () => {
    mockRun.mockImplementation(async (_cmd, args) => {
      if (args[args.length - 1]!.startsWith('registry:5000/')) throw new Error('not found');
      return JSON.stringify({ created: '2026-06-01T00:00:00Z' });
    });
    expect(await resolveBaseImageCreatedAt(source({ imageSource: 'uploaded' }), REGISTRY)).toEqual(new Date('2026-06-01T00:00:00Z'));
    expect(mockRun.mock.calls.map((c) => c[1][c[1].length - 1])).toEqual([
      'registry:5000/library/pipeline-plugin-base:24.04', 'docker.io/library/pipeline-plugin-base:24.04',
    ]);
  });

  it('is null — never a throw — when nothing can be read', async () => {
    mockRun.mockRejectedValue(new Error('registry down'));
    expect(await resolveBaseImageCreatedAt(source(), REGISTRY)).toBeNull();
    expect(await resolveBaseImageCreatedAt(source({ dockerfile: 'FROM scratch', imageSource: 'uploaded' }), REGISTRY)).toBeNull();
    mockWriteAuth.mockImplementationOnce(() => { throw new Error('no signing key'); });
    expect(await resolveBaseImageCreatedAt(source(), REGISTRY)).toBeNull();
  });
});
