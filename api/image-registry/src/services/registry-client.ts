// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Agent } from 'https';
import type { Readable } from 'stream';
import { createLogger } from '@pipeline-builder/api-core';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { config } from '../config';
import { authorizeAndIssue } from './token-service';

const logger = createLogger('registry-client');

/** Read timeout for blob streaming — short to fail fast on stuck upstream connections. */
const BLOB_STREAM_TIMEOUT_MS = 30_000;

const protocol = config.registry.http ? 'http' : 'https';
const baseURL = `${protocol}://${config.registry.host}:${config.registry.port}`;

/**
 * Pre-configured client for talking to the underlying Docker registry's
 * v2 HTTP API. Authenticates with the service-account credentials in
 * config (these never leave this service — customers don't see them).
 *
 * The registry will respond with 401 + Bearer challenge for token-auth
 * mode, but our service uses the registry's catalog/manifest/blob v2 API
 * for management ops only — and for those, we follow the same flow
 * customers do: we construct a `management` identity in-process and mint
 * a token via `token-service`, and use it here.
 *
 * For simplicity, the management endpoints use a self-issued token that
 * carries `*` actions on all repos.
 */
const client: AxiosInstance = axios.create({
  baseURL,
  timeout: 30_000,
  // Self-signed registry support — same flag the existing api/plugin docker
  // strategies use (`IMAGE_REGISTRY_INSECURE`).
  httpsAgent: new Agent({ rejectUnauthorized: !config.registry.insecure }),
});

let cachedManagementToken: { token: string; expiresAt: number } | null = null;

/** Lazily compute the management token used for our outbound calls to the underlying registry. */
async function getManagementToken(): Promise<string> {
  const now = Date.now();
  if (cachedManagementToken && cachedManagementToken.expiresAt > now + 30_000) {
    return cachedManagementToken.token;
  }

  // Mint a token in-process for our own management calls — same logic the
  // /token endpoint runs for external callers, just skipping the HTTP hop.
  const token = authorizeAndIssue(
    { type: 'management' as const },
    [{ type: 'registry', name: 'catalog', actions: ['*'] }],
    'pipeline-image-registry-management',
  );

  cachedManagementToken = {
    token,
    // Token lifetime is set by config.tokenSigning.expiresInSeconds; cache
    // for 80% of that to leave headroom.
    expiresAt: now + (config.tokenSigning.expiresInSeconds * 1000 * 0.8),
  };
  return token;
}

/** Wrap a request with a fresh bearer token. */
async function authedClient(): Promise<AxiosInstance> {
  const token = await getManagementToken();
  return axios.create({
    baseURL,
    timeout: 30_000,
    httpsAgent: client.defaults.httpsAgent,
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface CatalogResponse {
  repositories: string[];
  next?: string;
}

/** GET /v2/_catalog with optional pagination. */
export async function listRepositories(opts: { n?: number; last?: string } = {}): Promise<CatalogResponse> {
  const c = await authedClient();
  const { data, headers } = await c.get<{ repositories: string[] }>('/v2/_catalog', {
    params: { ...(opts.n && { n: opts.n }), ...(opts.last && { last: opts.last }) },
  });

  // The registry signals more pages via a Link header (RFC 5988) like:
  //   `Link: </v2/_catalog?n=10&last=foo>; rel="next"`
  // We extract the `last` parameter so callers can paginate naturally.
  const linkHeader = headers.link as string | undefined;
  const nextMatch = linkHeader?.match(/last=([^&>]+)/);
  return {
    repositories: data.repositories,
    ...(nextMatch && { next: decodeURIComponent(nextMatch[1]) }),
  };
}

/** GET /v2/<name>/tags/list */
export async function listTags(name: string): Promise<{ name: string; tags: string[] }> {
  const c = await authedClient();
  const { data } = await c.get<{ name: string; tags: string[] | null }>(
    `/v2/${encodeURIComponent(name)}/tags/list`,
  );
  return { name: data.name, tags: data.tags ?? [] };
}

/**
 * GET /v2/<name>/manifests/<reference>. Returns both the raw manifest body
 * and the digest header — callers need both for delete and tag-copy.
 */
export async function getManifest(
  name: string,
  reference: string,
): Promise<{ body: unknown; digest: string; mediaType: string }> {
  const c = await authedClient();
  const { data, headers } = await c.get<unknown>(
    `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(reference)}`,
    {
      // Distribution v2 + OCI both, plus manifest list for multi-arch.
      headers: {
        Accept: [
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.oci.image.index.v1+json',
        ].join(', '),
      },
    },
  );

  const digest = headers['docker-content-digest'] as string;
  const mediaType = headers['content-type'] as string;
  return { body: data, digest, mediaType };
}

/** DELETE /v2/<name>/manifests/<digest>. Reference must be a digest, not a tag. */
export async function deleteManifest(name: string, digest: string): Promise<void> {
  const c = await authedClient();
  await c.delete(`/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(digest)}`);
}

/**
 * Tag-copy: PUT a fetched manifest under a new reference. Distribution
 * accepts a manifest PUT for any reference; this is how `docker tag` +
 * `docker push <new-tag>` is implemented under the hood.
 */
export async function putManifest(
  name: string,
  reference: string,
  body: unknown,
  mediaType: string,
): Promise<{ digest: string }> {
  const c = await authedClient();
  const { headers } = await c.put<unknown>(
    `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(reference)}`,
    body,
    { headers: { 'Content-Type': mediaType } },
  );
  return { digest: headers['docker-content-digest'] as string };
}

/**
 * HEAD a manifest to learn its digest without downloading the body.
 * Used by the overwrite-guard on cross-repo copy. Returns null on 404.
 * Falls back to GET if the registry omits `Docker-Content-Digest` on HEAD
 * (older registries did this; modern distribution always sets it).
 */
export async function headManifest(
  name: string,
  reference: string,
): Promise<{ digest: string } | null> {
  const c = await authedClient();
  try {
    const { headers } = await c.head<unknown>(
      `/v2/${encodeURIComponent(name)}/manifests/${encodeURIComponent(reference)}`,
      {
        headers: {
          Accept: [
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.oci.image.index.v1+json',
          ].join(', '),
        },
      },
    );
    const digest = headers['docker-content-digest'] as string | undefined;
    if (digest) return { digest };
    // Fall back to GET — the body is small (a manifest, not a layer).
    const m = await getManifest(name, reference);
    return { digest: m.digest };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * HEAD a blob to read Content-Length without downloading the body.
 * Used by the blob-proxy to reject oversize blobs before opening the stream.
 */
export async function headBlob(
  name: string,
  digest: string,
): Promise<{ contentLength?: number }> {
  const c = await authedClient();
  const { headers } = await c.head<unknown>(
    `/v2/${encodeURIComponent(name)}/blobs/${encodeURIComponent(digest)}`,
  );
  const raw = headers['content-length'];
  const contentLength = typeof raw === 'string' ? parseInt(raw, 10) : undefined;
  return { contentLength: Number.isFinite(contentLength) ? contentLength : undefined };
}

/**
 * GET a blob as a Readable stream. Caller is responsible for piping to the
 * response AND enforcing any byte-cap. Stream timeout is short
 * ({@link BLOB_STREAM_TIMEOUT_MS}) so stuck upstream connections fail fast.
 */
export async function getBlobStream(
  name: string,
  digest: string,
): Promise<{ stream: Readable; contentType: string; contentLength?: number }> {
  const c = await authedClient();
  const response: AxiosResponse<Readable> = await c.get<Readable>(
    `/v2/${encodeURIComponent(name)}/blobs/${encodeURIComponent(digest)}`,
    {
      responseType: 'stream',
      timeout: BLOB_STREAM_TIMEOUT_MS,
    },
  );
  const contentType = (response.headers['content-type'] as string) || 'application/octet-stream';
  const raw = response.headers['content-length'];
  const cl = typeof raw === 'string' ? parseInt(raw, 10) : undefined;
  return {
    stream: response.data,
    contentType,
    contentLength: Number.isFinite(cl) ? cl : undefined,
  };
}

/**
 * Cross-mount a blob from `fromRepo` into `toRepo`. The blob bytes are
 * never transferred — the registry just makes the digest reachable from
 * the target repo's view. Used by cross-repo tag-copy to avoid re-uploading
 * layers that already live on the same registry.
 *
 * 201 → mounted (or already present, which is a no-op).
 * 202 → registry fell back to a regular upload session. For our case
 *       (same registry, blob known to exist in source) this is unexpected
 *       and is treated as an error.
 */
export async function mountBlob(
  fromRepo: string,
  toRepo: string,
  digest: string,
): Promise<{ mounted: true }> {
  const c = await authedClient();
  const response = await c.post<unknown>(
    `/v2/${encodeURIComponent(toRepo)}/blobs/uploads/`,
    null,
    {
      params: { mount: digest, from: fromRepo },
      // Distribution returns 201/202; both are non-error in axios's eyes
      // when we widen the validator.
      validateStatus: (s) => s === 201 || s === 202,
    },
  );
  if (response.status !== 201) {
    throw new Error(
      `Cross-mount fell back to upload (status ${response.status}); blob ${digest} from ${fromRepo} did not mount into ${toRepo}.`,
    );
  }
  return { mounted: true };
}

/** Best-effort 404 detection for axios errors. */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'response' in err &&
    typeof (err as { response?: { status?: number } }).response?.status === 'number' &&
    (err as { response: { status: number } }).response.status === 404
  );
}

logger.info('Registry client initialized', {
  baseURL,
  insecure: config.registry.insecure,
});
