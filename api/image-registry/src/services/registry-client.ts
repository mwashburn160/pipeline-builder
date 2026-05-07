// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Agent } from 'https';
import { createLogger } from '@pipeline-builder/api-core';
import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { authorizeAndIssue } from './token-service';

const logger = createLogger('registry-client');

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

logger.info('Registry client initialized', {
  baseURL,
  insecure: config.registry.insecure,
});
