// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The BASE IMAGE age of a plugin image (freshness): the
 * config `created` time of the image its final stage is built `FROM`, recorded
 * on the listed version at publish.
 *
 * Which base:
 *  1. For a platform BUILT image, BuildKit's SLSA provenance (min mode) lists
 *     every pulled image as a material with its resolved digest. The one whose
 *     name matches the Dockerfile's final-stage base (or the only one) wins —
 *     pinned by digest, so a moved tag can't make an old base look new.
 *  2. Otherwise the Dockerfile's own final-stage `FROM` reference (a digest pin
 *     when the author pinned one, else its tag).
 *
 * Unqualified Docker Hub names resolve through the in-cluster registry first
 * (buildkitd mirrors docker.io there — `library/<name>`), then upstream.
 *
 * Best effort by design: every failure (no provenance, unreadable config,
 * unreachable registry, bad timestamp) is `null`, and publish never fails on it.
 */

import * as fs from 'fs';

import { createLogger, errorMessage, parseDockerfile, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

import { run } from './build-process.js';
import { imageRepository, writeAuthConfig, type RegistryInfo } from './registry-auth.js';

// Deliberately NOT imported from docker-build / supply-chain: this module sits
// on the publish-decision path, which must not pull the build toolchain in.
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Same env + default as docker-build's PUBLISH_PLATFORM (the platform the plugin image is published for). */
const PUBLISH_PLATFORM = process.env.PUBLISH_PLATFORM || 'linux/amd64';

const logger = createLogger('base-image');

/** Each registry call is bounded (publish waits on it). */
const STEP_TIMEOUT_MS = 30_000;
const DOCKER_PURL = 'pkg:docker/';
/** The Dockerfile frontend image BuildKit also records as a material (`# syntax=`). */
const FRONTEND_IMAGES = new Set(['docker/dockerfile', 'docker/dockerfile-upstream']);

export interface BaseImageSource {
  orgId: string;
  name: string;
  imageDigest: string | null;
  imageSource: string | null;
  dockerfile: string | null;
}

/** An image material from the provenance: its repository name and resolved digest. */
export interface ProvenanceMaterial {
  name: string;
  digest: string;
}

/** A parsed image reference. `host` null = Docker Hub. */
export interface ParsedImageRef {
  host: string | null;
  path: string;
  tag: string | null;
  digest: string | null;
}

/** Split `[host[:port]/]path[:tag][@sha256:…]`. Never throws; null for garbage. */
export function parseImageRef(ref: string): ParsedImageRef | null {
  const trimmed = ref.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('$')) return null;
  let rest = trimmed;
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest)) return null;
  }
  let host: string | null = null;
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      host = first;
      rest = rest.slice(slash + 1);
    }
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon > 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!rest) return null;
  if (host === 'docker.io' || host === 'index.docker.io' || host === 'registry-1.docker.io') host = null;
  return { host, path: rest, tag, digest };
}

/** The repository name comparable across a Dockerfile ref and a purl (`library/` dropped for Hub). */
function comparableName(p: Pick<ParsedImageRef, 'host' | 'path'>): string {
  const path = p.host === null && p.path.startsWith('library/') ? p.path.slice('library/'.length) : p.path;
  return `${p.host ?? ''}/${path}`.toLowerCase();
}

/**
 * The image materials of a SLSA provenance statement (v0.2 `materials` or v1
 * `resolvedDependencies`): docker purls with a sha256 digest, the Dockerfile
 * frontend image excluded. Pure.
 */
export function provenanceImageMaterials(statement: unknown): ProvenanceMaterial[] {
  const predicate = (statement as { predicate?: Record<string, unknown> } | null)?.predicate;
  if (!predicate || typeof predicate !== 'object') return [];
  const v1 = (predicate.buildDefinition as { resolvedDependencies?: unknown } | undefined)?.resolvedDependencies;
  const list = Array.isArray(predicate.materials) ? predicate.materials : Array.isArray(v1) ? v1 : [];
  const out: ProvenanceMaterial[] = [];
  for (const m of list as Array<{ uri?: unknown; digest?: { sha256?: unknown } }>) {
    if (typeof m?.uri !== 'string' || !m.uri.startsWith(DOCKER_PURL)) continue;
    const sha = m.digest?.sha256;
    if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) continue;
    // pkg:docker/<name>@<version>?<qualifiers> — <name> is percent-encoded.
    const body = m.uri.slice(DOCKER_PURL.length).split('?')[0]!;
    const at = body.lastIndexOf('@');
    let name: string;
    try {
      name = decodeURIComponent(at > 0 ? body.slice(0, at) : body);
    } catch {
      continue;
    }
    const parsed = parseImageRef(name);
    if (!parsed || FRONTEND_IMAGES.has(comparableName(parsed).replace(/^\//, ''))) continue;
    out.push({ name, digest: `sha256:${sha}` });
  }
  return out;
}

/**
 * The base image reference to read, from the provenance materials and the
 * Dockerfile's final-stage base: the material matching the Dockerfile base by
 * name, else the only material, else the Dockerfile reference itself. Pure.
 */
export function selectBaseImageRef(dockerfileBase: string | null, materials: readonly ProvenanceMaterial[]): string | null {
  const base = dockerfileBase ? parseImageRef(dockerfileBase) : null;
  if (base) {
    const match = materials.find((m) => {
      const p = parseImageRef(m.name);
      return p !== null && comparableName(p) === comparableName(base);
    });
    if (match) return `${match.name.replace(/:[^/:]*$/, '')}@${match.digest}`;
  }
  if (materials.length === 1) {
    const only = materials[0]!;
    return `${only.name.replace(/:[^/:]*$/, '')}@${only.digest}`;
  }
  if (!base) return null;
  return dockerfileBase;
}

/**
 * Where to fetch a base reference from, in order: a Docker Hub name through
 * the in-cluster mirror (`<registry>/library/<name>` or `<registry>/<ns>/<name>`)
 * and then upstream; any other registry as written. Pure.
 */
export function baseImageLocations(ref: string, registry: RegistryInfo): string[] {
  const p = parseImageRef(ref);
  if (!p) return [];
  const suffix = p.digest ? `@${p.digest}` : `:${p.tag ?? 'latest'}`;
  if (p.host !== null) return [`${p.host}/${p.path}${suffix}`];
  const hubPath = p.path.includes('/') ? p.path : `library/${p.path}`;
  return [`${registry.host}:${registry.port}/${hubPath}${suffix}`, `docker.io/${hubPath}${suffix}`];
}

/** An image config's `created`, as a Date; null when absent or unparseable. */
export function configCreatedAt(configJson: string): Date | null {
  try {
    const created = (JSON.parse(configJson) as { created?: unknown }).created;
    if (typeof created !== 'string') return null;
    const d = new Date(created);
    // Reproducible builds stamp the epoch (1970) — that's "unknown", not "ancient".
    return Number.isFinite(d.getTime()) && d.getTime() > 0 ? d : null;
  } catch {
    return null;
  }
}

type Env = Record<string, string>;

async function crane(args: string[], registry: RegistryInfo, env: Env): Promise<string> {
  return run('crane', [...(registry.http ? ['--insecure'] : []), ...args], STEP_TIMEOUT_MS, env, { captureStdout: true });
}

/** The pushed image's BuildKit provenance statement (attestation manifest in its index), or null. */
async function readProvenance(ref: string, repository: string, registry: RegistryInfo, env: Env): Promise<unknown> {
  const index = JSON.parse(await crane(['manifest', ref], registry, env)) as {
    manifests?: Array<{ digest?: string; annotations?: Record<string, string> }>;
  };
  const attestation = (index.manifests ?? []).find((m) => m.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest');
  if (!attestation?.digest || !DIGEST_RE.test(attestation.digest)) return null;
  const manifest = JSON.parse(await crane(['manifest', `${repository}@${attestation.digest}`], registry, env)) as {
    layers?: Array<{ digest?: string; annotations?: Record<string, string> }>;
  };
  const layer = (manifest.layers ?? []).find((l) => (l.annotations?.['in-toto.io/predicate-type'] ?? '').startsWith('https://slsa.dev/provenance/'));
  if (!layer?.digest || !DIGEST_RE.test(layer.digest)) return null;
  return JSON.parse(await crane(['blob', `${repository}@${layer.digest}`], registry, env));
}

/**
 * The base image's `created` time for a plugin image, or null (see the module
 * note). Never throws.
 */
export async function resolveBaseImageCreatedAt(source: BaseImageSource, registry: RegistryInfo): Promise<Date | null> {
  const dockerfileBase = parseDockerfile(source.dockerfile).baseImage;
  let dockerConfigDir: string | null = null;
  try {
    // Pull-only credential for the in-cluster registry (the org's own image
    // and the mirrored bases); upstream registries are read anonymously.
    dockerConfigDir = writeAuthConfig(registry, source.orgId || SYSTEM_ORG_ID, Math.ceil((4 * STEP_TIMEOUT_MS) / 1000), 'pull');
    const env: Env = { DOCKER_CONFIG: dockerConfigDir };

    let materials: ProvenanceMaterial[] = [];
    if (source.imageSource === 'built' && source.imageDigest && DIGEST_RE.test(source.imageDigest)) {
      const repository = imageRepository(source.name, registry, source.orgId);
      try {
        materials = provenanceImageMaterials(await readProvenance(`${repository}@${source.imageDigest}`, repository, registry, env));
      } catch (err) {
        logger.debug('Provenance unreadable; using the Dockerfile base', { name: source.name, error: errorMessage(err) });
      }
    }
    const baseRef = selectBaseImageRef(dockerfileBase, materials);
    if (!baseRef) return null;

    for (const location of baseImageLocations(baseRef, registry)) {
      try {
        const created = configCreatedAt(await crane(['config', '--platform', PUBLISH_PLATFORM, location], registry, env));
        if (created) return created;
      } catch (err) {
        logger.debug('Base image config unreadable', { location, error: errorMessage(err) });
      }
    }
    return null;
  } catch (err) {
    logger.warn('Base image age not recorded', { name: source.name, error: errorMessage(err) });
    return null;
  } finally {
    if (dockerConfigDir) fs.rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}
