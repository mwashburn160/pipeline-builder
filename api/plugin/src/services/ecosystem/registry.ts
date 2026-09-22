// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for image-registry's `/internal/plugin-publications*` routes — the
 * `public/<publisher>/<name>` namespace (docs/plans/plugin-ecosystem.md §3.3).
 * The plugin service decides WHAT is published, re-signed or yanked (approval,
 * tier, suspension, transfer); image-registry does the registry side with the
 * only identity allowed to write `public/*`.
 *
 * Calls carry a service token minted for the SYSTEM org (governance decisions),
 * or for the source org on publish (image-registry accepts either). No retries
 * on writes: publish and re-sign are idempotent server-side, and the caller
 * (approval / the re-sign job) owns the retry.
 */

import { getServiceAuthHeader, InternalHttpClient, SYSTEM_ORG_ID } from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

export type TrustTier = 'official' | 'verified' | 'community' | 'unverified';

/** A registry call was refused or failed; `status` is the HTTP status (0 = transport). */
export class RegistryPublicationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RegistryPublicationError';
  }
}

const TIMEOUT_MS = 10 * 60_000;

type RegistryHttp = Pick<InternalHttpClient, 'post' | 'get'> & Partial<Pick<InternalHttpClient, 'delete'>>;

let clientOverride: RegistryHttp | null = null;

/** Test hook: replace the HTTP client. */
export function setRegistryClientForTests(c: RegistryHttp | null): void {
  clientOverride = c;
}

function client(): RegistryHttp {
  if (clientOverride) return clientOverride;
  const services = Config.get('server').services;
  return new InternalHttpClient({ host: services.imageRegistryHost, port: services.imageRegistryPort, timeout: TIMEOUT_MS });
}

function auth(orgId: string = SYSTEM_ORG_ID): Record<string, string> {
  return { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId, role: 'member' }) };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res;
  try {
    res = await client().post<{ data?: T; message?: string }>(`/internal/plugin-publications${path}`, body, { headers: auth(), maxRetries: 0 });
  } catch (err) {
    throw new RegistryPublicationError(`image-registry unreachable: ${(err as Error).message}`, 0);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new RegistryPublicationError(`image-registry refused ${path || 'publish'} (HTTP ${res.statusCode}): ${res.body?.message ?? 'no detail'}`, res.statusCode);
  }
  return (res.body?.data ?? {}) as T;
}

export interface PublishImageParams {
  /** `org-<id>/<name>`, `system/<name>`, or an approved submission's `quarantine/<submissionId>`. */
  sourceRepository: string;
  digest: string;
  publisherHandle: string;
  name: string;
  version: string;
  tier: TrustTier;
  /** The publisher's org (storage attribution); null for the platform `community` publisher. */
  publisherOrgId: string | null;
}

/** Copy the pinned digest into `public/<publisher>/<name>`, sign it fresh with the tier, tag the version. */
export function publishImage(p: PublishImageParams): Promise<{ imageRepository: string; digest: string }> {
  return post('', p);
}

export interface ResignParams {
  imageRepository: string;
  digest: string;
  publisherHandle: string;
  tier: TrustTier;
  publisherOrgId?: string | null;
  progress?: { completed: number; total: number };
}

/** Replace a public image's signature with new trust/publisher annotations (§3.3 re-sign job). */
export function resignImage(p: ResignParams): Promise<unknown> {
  return post('/resign', p);
}

/** Remove a public version TAG (content stays: deployed pipelines pull by digest). */
export function yankImage(p: { imageRepository: string; version: string; digest: string }): Promise<unknown> {
  return post('/yank', p);
}

/**
 * Put a yanked version's TAG back on its published digest (unyank). Works from
 * the listing version alone — the manifest is still in `public/*`, so the
 * source org's row is not needed.
 */
export function retagImage(p: { imageRepository: string; version: string; digest: string }): Promise<unknown> {
  return post('/retag', p);
}

/** What image-registry verified about a published image: the signature and its trust annotations. */
export interface PublicationVerification {
  signed: boolean;
  tier: TrustTier | null;
  publisher: string | null;
}

/**
 * Verify a `public/*` image's signature and read its signed `pb.trust` /
 * `pb.publisher` annotations (§3.3). Lookup compares them with the listing's
 * publisher, so a tier changed in the database without a re-sign is caught.
 */
export async function verifyPublication(imageRepository: string, digest: string): Promise<PublicationVerification> {
  const query = `?imageRepository=${encodeURIComponent(imageRepository)}&digest=${encodeURIComponent(digest)}`;
  let res;
  try {
    res = await client().get<{ data?: PublicationVerification; message?: string }>(`/internal/plugin-publications/verify${query}`, { headers: auth() });
  } catch (err) {
    throw new RegistryPublicationError(`image-registry unreachable: ${(err as Error).message}`, 0);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new RegistryPublicationError(`image-registry refused verify (HTTP ${res.statusCode}): ${res.body?.message ?? 'no detail'}`, res.statusCode);
  }
  const data = res.body?.data;
  return { signed: data?.signed === true, tier: data?.tier ?? null, publisher: data?.publisher ?? null };
}

/** Drop image-registry's verify cache for one repository/digest, or all of it. */
export function invalidateVerifyCache(p: { imageRepository?: string; digest?: string } = {}): Promise<unknown> {
  return post('/verify-cache/invalidate', p);
}

/**
 * Drop an anonymous submission's quarantined build (`quarantine/<submissionId>`)
 * once it is expired, rejected or failed (§4.2). Idempotent server-side; the
 * registry's 30-day quarantine sweep is the backstop.
 */
export async function deleteQuarantineImage(submissionId: string): Promise<void> {
  const c = client();
  if (!c.delete) throw new RegistryPublicationError('image-registry client cannot delete', 0);
  let res;
  try {
    res = await c.delete<{ message?: string }>(`/internal/quarantine/${encodeURIComponent(submissionId)}`, { headers: auth(), maxRetries: 0 });
  } catch (err) {
    throw new RegistryPublicationError(`image-registry unreachable: ${(err as Error).message}`, 0);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new RegistryPublicationError(`image-registry refused the quarantine delete (HTTP ${res.statusCode}): ${res.body?.message ?? 'no detail'}`, res.statusCode);
  }
}
