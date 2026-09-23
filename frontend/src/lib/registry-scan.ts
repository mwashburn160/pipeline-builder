// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared vocabulary and bounded-concurrency helpers for the registry browser.
 *
 * The registry surfaces (tag table, manifest detail, the delete confirms) all
 * answer their questions by reading one manifest per tag. Those reads need a
 * concurrency cap so a repo with hundreds of tags doesn't open hundreds of
 * sockets, and the "which other tags share this digest?" question is asked by
 * two different surfaces — so the wave loop and the scan live here once rather
 * than being re-derived (with drifting caps) at each call site.
 */

import { api } from '@/lib/api';

/** Media types that denote a multi-arch INDEX rather than a single image manifest. */
export const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

/** Media types that denote a single-architecture image manifest. */
export const IMAGE_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);

/** Manifest reads in flight at once. */
export const PARALLEL_MANIFEST_READS = 8;

/** Destructive writes in flight at once — deliberately lower than reads. */
export const PARALLEL_MANIFEST_DELETES = 4;

/** How many tags a digest scan will read before it stops and reports the rest
 *  as unscanned. Bounds the wait on a repo with hundreds of tags. */
export const MAX_TAGS_TO_SCAN = 50;

/**
 * Run `worker` over `items` in waves of `concurrency`, awaiting each wave.
 *
 * Returns `false` when `isCancelled` asked it to stop between waves (the
 * caller's component unmounted, or its inputs changed), `true` when the whole
 * list was walked.
 */
export async function mapInWaves<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  isCancelled: () => boolean = () => false,
): Promise<boolean> {
  for (let i = 0; i < items.length; i += concurrency) {
    if (isCancelled()) return false;
    await Promise.all(items.slice(i, i + concurrency).map(worker));
  }
  return !isCancelled();
}

export interface DigestScanHooks {
  /** Stop between waves — typically the caller's `cancelled` flag. */
  isCancelled: () => boolean;
  /** Called once the tag list is known: how many tags will be read, and how
   *  many the {@link MAX_TAGS_TO_SCAN} cap left unscanned. */
  onScope?: (toScan: number, skipped: number) => void;
  /** Called after each tag is read, with the running count. */
  onProgress?: (scanned: number) => void;
}

/**
 * Which tags in `repo` point at `digest`?
 *
 * The answer matters before a delete: distribution removes manifests BY DIGEST,
 * so deleting one tag breaks every other tag on the same digest. Reads up to
 * {@link MAX_TAGS_TO_SCAN} tags, {@link PARALLEL_MANIFEST_READS} at a time, and
 * reports progress so a slow registry doesn't leave a blank panel for seconds.
 *
 * A tag whose manifest read fails is skipped, not fatal — it still counts
 * towards progress. Includes the tag the caller started from; filter it out at
 * render rather than re-scanning when the selection changes.
 *
 * Returns the matching tags sorted, or `null` when cancelled.
 */
export async function scanTagsForDigest(
  repo: string,
  digest: string,
  hooks: DigestScanHooks,
): Promise<string[] | null> {
  const { isCancelled, onScope, onProgress } = hooks;
  const res = await api.listImageTags(repo);
  if (isCancelled()) return null;

  const allTags = res.data?.tags ?? [];
  const toScan = allTags.slice(0, MAX_TAGS_TO_SCAN);
  onScope?.(toScan.length, Math.max(0, allTags.length - toScan.length));

  const found: string[] = [];
  let scanned = 0;
  const readOne = async (tag: string) => {
    try {
      const manifest = await api.getImageManifest(repo, tag);
      if (manifest.data?.digest === digest) found.push(tag);
    } catch {
      // A tag we can't read tells us nothing; it still counts as scanned.
    }
    scanned++;
    if (!isCancelled()) onProgress?.(scanned);
  };

  const completed = await mapInWaves(toScan, PARALLEL_MANIFEST_READS, readOne, isCancelled);
  return completed ? found.sort() : null;
}
