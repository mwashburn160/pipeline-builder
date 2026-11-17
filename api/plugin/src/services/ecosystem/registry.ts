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

import {
  callInternal,
  ContractRequestError,
  getServiceAuthHeader,
  IMAGE_REGISTRY_INTERNAL,
  InternalHttpClient,
  SYSTEM_ORG_ID,
  type ContractHttpClient,
  type ContractResponse,
  type InternalCallInput,
  type InternalEndpointContract,
  type PublisherTier,
} from '@pipeline-builder/api-core';
import { Config } from '@pipeline-builder/pipeline-core';

/** A registry call was refused or failed; `status` is the HTTP status (0 = transport). */
export class RegistryPublicationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RegistryPublicationError';
  }
}

/**
 * How long one image-registry call may take. Equal to image-registry's
 * `PUBLICATION_TIMEOUT_MS` (api/image-registry/src/routes/internal-publications.ts);
 * a deploy-contracts test keeps the two equal.
 */
const TIMEOUT_MS = 600_000;

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

const C = IMAGE_REGISTRY_INTERNAL;

/**
 * One image-registry call through its contract: a transport failure is status
 * 0, a non-2xx a refusal naming `what`, and a 2xx whose reply the contract
 * cannot read a refusal with that 2xx status. Returns the parsed `data`.
 */
async function call<K extends InternalEndpointContract>(
  contract: K, what: string, input: Omit<InternalCallInput<K>, 'options'> = {},
  /** The caller never reads the reply: any 2xx is the success, readable or not. */
  replyUnused = false,
): Promise<ContractResponse<K>> {
  const c = client();
  if (contract.method === 'DELETE' && !c.delete) throw new RegistryPublicationError('image-registry client cannot delete', 0);
  const options = { headers: { Authorization: getServiceAuthHeader({ serviceName: 'plugin', orgId: SYSTEM_ORG_ID, role: 'member' }) }, maxRetries: 0 };
  let res;
  try {
    // Only the verb the contract names is called, so a test double holding
    // just `get` / `post` (and `delete`) is enough.
    res = await callInternal(c as unknown as ContractHttpClient, contract, { ...input, options });
  } catch (err) {
    // A body the contract rejects was never sent: the registry would have
    // answered it 400, so it is reported as that refusal.
    if (err instanceof ContractRequestError) throw new RegistryPublicationError(`image-registry refused ${what} (HTTP 400): ${err.message}`, 400);
    throw new RegistryPublicationError(`image-registry unreachable: ${(err as Error).message}`, 0);
  }
  if (res.ok) return res.data;
  if (res.reason === 'invalid-response' && replyUnused) return undefined as ContractResponse<K>;
  if (res.reason === 'unreachable') throw new RegistryPublicationError('image-registry unreachable: no response', 0);
  if (res.reason === 'invalid-response') {
    throw new RegistryPublicationError(`image-registry refused ${what} (HTTP ${res.status}): unreadable reply (${res.error})`, res.status);
  }
  const message = (res.body as { message?: string } | undefined)?.message;
  throw new RegistryPublicationError(`image-registry refused ${what} (HTTP ${res.status}): ${message ?? 'no detail'}`, res.status);
}

export interface PublishImageParams {
  /** `org-<id>/<name>`, `system/<name>`, or an approved submission's `quarantine/<submissionId>`. */
  sourceRepository: string;
  digest: string;
  publisherHandle: string;
  name: string;
  version: string;
  tier: PublisherTier;
  /** The publisher's org (storage attribution); null for the platform `community` publisher. */
  publisherOrgId: string | null;
  /** The user whose decision this executes (the approver) — the registry's audit actor. */
  actorId?: string;
}

/** Copy the pinned digest into `public/<publisher>/<name>`, sign it fresh with the tier, tag the version. */
export function publishImage(p: PublishImageParams): Promise<{ imageRepository: string; digest: string }> {
  return call(C.publishPublicImage, 'publish', { body: p });
}

export interface ResignParams {
  imageRepository: string;
  digest: string;
  publisherHandle: string;
  tier: PublisherTier;
  publisherOrgId?: string | null;
  progress?: { completed: number; total: number };
  /** The user who triggered the re-sign (tier change, suspension, transfer) — the registry's audit actor. */
  actorId?: string;
}

/** Replace a public image's signature with new trust/publisher annotations (the re-sign job). */
export function resignImage(p: ResignParams): Promise<unknown> {
  return call(C.resignPublicImage, '/resign', { body: p }, true);
}

/** Remove a public version TAG (content stays: deployed pipelines pull by digest). */
export function yankImage(p: { imageRepository: string; version: string; digest: string; actorId?: string }): Promise<unknown> {
  return call(C.yankPublicVersion, '/yank', { body: p }, true);
}

/**
 * Put a yanked version's TAG back on its published digest (unyank). Works from
 * the listing version alone — the manifest is still in `public/*`, so the
 * source org's row is not needed.
 */
export function retagImage(p: { imageRepository: string; version: string; digest: string; actorId?: string }): Promise<unknown> {
  return call(C.retagPublicVersion, '/retag', { body: p }, true);
}

/** What image-registry verified about a published image: the signature and its trust annotations. */
export interface PublicationVerification {
  signed: boolean;
  tier: PublisherTier | null;
  publisher: string | null;
}

/**
 * Verify a `public/*` image's signature and read its signed `pb.trust` /
 * `pb.publisher` annotations. Lookup compares them with the listing's
 * publisher, so a tier changed in the database without a re-sign is caught.
 */
export async function verifyPublication(imageRepository: string, digest: string): Promise<PublicationVerification> {
  return call(C.verifyPublication, 'verify', { query: { imageRepository, digest } });
}

/** Drop image-registry's verify cache for one repository/digest, or all of it. */
export function invalidateVerifyCache(p: { imageRepository?: string; digest?: string } = {}): Promise<unknown> {
  return call(C.invalidateVerifyCache, '/verify-cache/invalidate', { body: p }, true);
}

/**
 * Drop an anonymous submission's quarantined build (`quarantine/<submissionId>`)
 * once it is expired, rejected, failed or published. Idempotent server-side; the
 * registry's 30-day quarantine sweep is the backstop.
 */
export async function deleteQuarantineImage(submissionId: string): Promise<void> {
  await call(C.deleteQuarantineRepository, 'the quarantine delete', { params: { submissionId } }, true);
}

/**
 * Delete one public digest the plugin service has cleared for collection
 * (yanked long enough ago, referenced by no live pipeline's step manifest).
 * image-registry refuses (409) a digest a tag still resolves to. Idempotent:
 * an already-deleted digest answers `deleted: false`.
 */
export async function gcImage(p: { imageRepository: string; digest: string; actorId?: string }): Promise<{ deleted: boolean }> {
  const data = await call(C.collectImage, '/gc', { body: p });
  return { deleted: data.deleted };
}

/**
 * Delete the `system/<name>` build copy of a system plugin version the
 * retention pass RETIRED (row purged, references re-checked). Same endpoint as
 * {@link gcImage}; image-registry's guard for this namespace refuses (409) a
 * digest any tag but `version`'s own — or a protected floating tag — still
 * resolves to.
 */
export async function gcSystemImage(p: { name: string; version: string; digest: string; actorId?: string }): Promise<{ deleted: boolean }> {
  const data = await call(C.collectImage, '/gc', {
    body: { imageRepository: `system/${p.name}`, digest: p.digest, version: p.version, ...(p.actorId ? { actorId: p.actorId } : {}) },
  });
  return { deleted: data.deleted };
}

/** One system plugin version's storage, every copy counted as one unit (image-registry's retention breakdown). */
export interface RetentionBreakdownEntry { name: string; version: string; totalBytes: number; marginalBytes: number }

/**
 * The system org's per-version retention breakdown, or null when image-registry
 * cannot answer — a caller then reports bytes as unknown, never as zero.
 */
export async function retentionBreakdown(): Promise<{ entries: RetentionBreakdownEntry[]; incomplete: boolean } | null> {
  try {
    const data = await call(C.orgStorageBreakdown, 'the retention breakdown', {
      params: { orgId: SYSTEM_ORG_ID }, query: { scope: 'retention' },
    });
    // The retention shape's entries are `{ name, version, … }`; the per-org
    // shape (which `scope=retention` never answers) is not a retention view.
    if ('orgId' in data) return null;
    return { entries: data.entries, incomplete: data.incomplete };
  } catch {
    return null;
  }
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
  const data = await call(C.mintQuarantineCredential, what, { params: { submissionId }, body: { ttlSeconds } });
  if (!data.password) throw new RegistryPublicationError(`image-registry refused ${what} (HTTP 200): no credential returned`, 200);
  return data;
}
