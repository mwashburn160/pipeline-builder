// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Client for image-registry's `/internal/plugin-publications*` and
 * `/internal/quarantine*` routes — the `public/<publisher>/<name>` namespace
 * and anonymous submissions' quarantined builds (docs/plugin-publishing.md).
 * The plugin service decides WHAT is published, re-signed, yanked or
 * collected (approval, tier, suspension, transfer, retention); image-registry
 * does the registry side with the only identity allowed to write `public/*`.
 *
 * Calls carry a service token minted for the SYSTEM org (governance
 * decisions). No retries on writes: every write is idempotent server-side, and
 * the caller (approval / the re-sign job / maintenance) owns the retry.
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

type Envelope<T> = { data?: T; message?: string };

/**
 * One image-registry call: a transport failure is status 0, a non-2xx a
 * refusal naming `what`. Returns the response's `data` (empty when absent).
 */
async function call<T>(method: 'get' | 'post' | 'delete', path: string, what: string, body?: unknown): Promise<T> {
  const c = client();
  const opts = { headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) }, maxRetries: 0 };
  let res;
  try {
    if (method === 'post') {res = await c.post<Envelope<T>>(path, body, opts);} else if (method === 'get') {res = await c.get<Envelope<T>>(path, opts);} else {
      if (!c.delete) throw new RegistryPublicationError('image-registry client cannot delete', 0);
      res = await c.delete<Envelope<T>>(path, opts);
    }
  } catch (err) {
    if (err instanceof RegistryPublicationError) throw err;
    throw new RegistryPublicationError(`image-registry unreachable: ${(err as Error).message}`, 0);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new RegistryPublicationError(`image-registry refused ${what} (HTTP ${res.statusCode}): ${res.body?.message ?? 'no detail'}`, res.statusCode);
  }
  return (res.body?.data ?? {}) as T;
}

const PUBLICATIONS = '/internal/plugin-publications';

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>('post', `${PUBLICATIONS}${path}`, path || 'publish', body);
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

/** Replace a public image's signature with new trust/publisher annotations (the re-sign job). */
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
 * `pb.publisher` annotations. Lookup compares them with the listing's
 * publisher, so a tier changed in the database without a re-sign is caught.
 */
export async function verifyPublication(imageRepository: string, digest: string): Promise<PublicationVerification> {
  const query = `?imageRepository=${encodeURIComponent(imageRepository)}&digest=${encodeURIComponent(digest)}`;
  const data = await call<Partial<PublicationVerification>>('get', `${PUBLICATIONS}/verify${query}`, 'verify');
  return { signed: data.signed === true, tier: data.tier ?? null, publisher: data.publisher ?? null };
}

/** Drop image-registry's verify cache for one repository/digest, or all of it. */
export function invalidateVerifyCache(p: { imageRepository?: string; digest?: string } = {}): Promise<unknown> {
  return post('/verify-cache/invalidate', p);
}

/**
 * Drop an anonymous submission's quarantined build (`quarantine/<submissionId>`)
 * once it is expired, rejected, failed or published. Idempotent server-side; the
 * registry's 30-day quarantine sweep is the backstop.
 */
export async function deleteQuarantineImage(submissionId: string): Promise<void> {
  await call('delete', `/internal/quarantine/${encodeURIComponent(submissionId)}`, 'the quarantine delete');
}

/**
 * Delete one public digest the plugin service has cleared for collection
 * (yanked long enough ago, referenced by no live pipeline's step manifest).
 * image-registry refuses (409) a digest a tag still resolves to. Idempotent:
 * an already-deleted digest answers `deleted: false`.
 */
export async function gcImage(p: { imageRepository: string; digest: string }): Promise<{ deleted: boolean }> {
  const data = await post<{ deleted?: boolean }>('/gc', p);
  return { deleted: data.deleted === true };
}

/** A registry-only credential for ONE quarantine repository (`quarantine/<submissionId>`). */
export interface QuarantineCredential {
  username: string;
  password: string;
  expiresAt: string;
}

/**
 * Mint the credential an anonymous build runs with: image-registry signs
 * it, and its token endpoint grants it push/pull on `quarantine/<submissionId>`
 * (plus pull on the base-image namespaces) and NOTHING else. It is not a
 * platform token — no service on the platform accepts it — so a build that
 * exfiltrates it from the quarantine buildkitd can reach only its own image.
 */
export async function mintQuarantineCredential(submissionId: string, ttlSeconds: number): Promise<QuarantineCredential> {
  const what = 'the quarantine credential';
  const data = await call<Partial<QuarantineCredential>>('post', `/internal/quarantine/${encodeURIComponent(submissionId)}/credential`, what, { ttlSeconds });
  if (!data.password) throw new RegistryPublicationError(`image-registry refused ${what} (HTTP 200): no credential returned`, 200);
  return data as QuarantineCredential;
}
