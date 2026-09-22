// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The listing half of `/plugins/lookup`: resolving a pipeline's plugin
 * reference through the org's installs, and verifying the listed image.
 */

import { ErrorCode, getStatusForErrorCode } from '@pipeline-builder/api-core';
import { listedPluginRecord, resolveListingReference, type ListingResolved, type ResolutionScope } from '@pipeline-builder/pipeline-data';

import { installRows, listingSource } from './installs-store.js';
import { codeOf } from './installs.js';
import { RegistryPublicationError, verifyPublication } from './registry.js';
import { resignGrace, trustFor } from './resign.js';
import { ImageVerificationError } from '../../helpers/supply-chain.js';

// -----------------------------------------------------------------------------
// Lookup (the listing half of `/plugins/lookup`)
// -----------------------------------------------------------------------------

/** A lookup resolved to a listed version: the run record plus what the route needs. */
export interface ListedLookup {
  resolution: ListingResolved;
  record: Record<string, unknown>;
}

/** A lookup the org's install or policy refuses, ready to answer. */
export interface RefusedLookup {
  refused: { status: number; code: ErrorCode; message: string; details: Record<string, unknown> };
}

/**
 * Resolve a reference to an installed listing for the caller. Null when no
 * such listing exists; the refusal (with its HTTP status) when the org can't
 * use it. Records what an explicit own-org install resolved to (paused
 * versions keep resolving for installs already on them).
 */
export async function resolveListedLookup(
  scope: ResolutionScope,
  ref: { publisher?: string; name: string; version?: string },
): Promise<ListedLookup | RefusedLookup | null> {
  const res = await resolveListingReference(listingSource, ref, scope);
  if (!res) return null;
  if (!res.ok) {
    const code = codeOf(res.refusal);
    return { refused: { status: getStatusForErrorCode(code), code, message: res.refusal.message, details: { reason: res.refusal.reason, ...(res.refusal.details ?? {}) } } };
  }
  if (res.mode.kind === 'explicit' && !res.mode.inherited && res.mode.install.resolvedVersion !== res.version.version && ref.version === undefined) {
    await installRows.update(res.mode.install.id, { resolvedVersion: res.version.version });
  }
  return { resolution: res, record: listedPluginRecord(res) };
}

/** Whether an unqualified reference to `name` would reach an Official listing if the org's own plugin didn't shadow it. */
export async function shadowedListing(scope: ResolutionScope, name: string): Promise<{ publisher: string; name: string } | null> {
  const res = await resolveListingReference(listingSource, { name }, scope).catch(() => null);
  return res && res.ok ? { publisher: res.publisher.handle, name: res.listing.name } : null;
}

/**
 * Verify a listed version's `public/*` image before lookup hands out its
 * digest: the signature must verify AND its signed `pb.trust` /
 * `pb.publisher` annotations must match the publisher's CURRENT tier and
 * handle — a tier changed in the database without a re-sign, or an image
 * signed for someone else, is refused. Throws {@link ImageVerificationError};
 * a registry outage rethrows as is.
 */
export async function verifyListedImage(res: Pick<ListingResolved, 'publisher' | 'listing' | 'version'>): Promise<void> {
  const { publisher, listing, version } = res;
  const ref = `${publisher.handle}/${listing.name}@${version.version}`;
  if (!version.imageDigest || !version.imageRepository) {
    throw new ImageVerificationError(`Plugin ${ref} has no published image`);
  }
  let verdict;
  try {
    verdict = await verifyPublication(version.imageRepository, version.imageDigest);
  } catch (err) {
    if (err instanceof RegistryPublicationError && err.status >= 400 && err.status < 500) {
      throw new ImageVerificationError(`Plugin ${ref} image could not be verified: ${err.message}`);
    }
    throw err;
  }
  if (!verdict.signed) throw new ImageVerificationError(`Plugin ${ref} image ${version.imageDigest} has no valid platform signature`);
  // The signature must carry the publisher's CURRENT trust (its tier, or
  // `unverified` while suspended — what the re-sign job signs with) and handle
  // — or, while a re-sign of this publisher/listing is still running, the
  // annotations it carried before the change (a grace period that ends with the job).
  const matches = (a: { tier: string; handle: string }) => verdict.tier === a.tier && verdict.publisher === a.handle;
  if (!matches({ tier: trustFor(publisher), handle: publisher.handle })
    && !(await resignGrace(publisher.id, listing.id)).some(matches)) {
    throw new ImageVerificationError(
      `Plugin ${ref} image is signed as ${verdict.tier ?? 'unknown'}/${verdict.publisher ?? 'unknown'}, `
      + `not ${trustFor(publisher)}/${publisher.handle}; it must be re-signed before it resolves`);
  }
}
