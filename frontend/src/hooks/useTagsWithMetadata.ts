// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

/** Per-tag metadata used to enrich the TagTable rows. */
export interface TagMetadata {
  isMultiArch: boolean;
  digest: string;
  digestShort: string;
  /** Total bytes — for indexes this is summed across child manifests + their layers (best-effort). */
  totalSize: number;
  created?: string;
}

/** Limit concurrent manifest fetches so we don't hammer the registry. */
const MAX_CONCURRENT = 8;

/**
 * Populate per-tag metadata (digest, multi-arch flag, total size, created date)
 * for the TagTable. Without this, the table renders tag names with `—` in every
 * detail column. Fetches manifests in parallel with a small concurrency cap.
 *
 * `created` and total bytes come from the config blob for single-arch images;
 * for indexes, total bytes is the sum of platform manifest + layer sizes, and
 * created is intentionally absent (no single config blob to derive it from).
 */
export function useTagsWithMetadata(repo: string | null, tags: string[] | null) {
  const [metadata, setMetadata] = useState<Map<string, TagMetadata>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!repo || !tags || tags.length === 0) {
      setMetadata(new Map());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const result = new Map<string, TagMetadata>();

    const fetchTag = async (tag: string) => {
      try {
        const res = await api.getImageManifest(repo, tag);
        if (cancelled) return;
        const m = res.data;
        if (!m) return;
        const isIndex = INDEX_MEDIA_TYPES.has(m.mediaType);
        const body = m.body as Record<string, unknown>;
        let totalSize = m.size ?? 0;
        let created: string | undefined;

        if (isIndex) {
          // For an index, sum the per-platform manifest sizes (cheap — we
          // have them in the index body — and skip the per-config blob fetch).
          const childManifests = (body.manifests as Array<{ size?: number }> | undefined) ?? [];
          totalSize = childManifests.reduce((sum, c) => sum + (c.size ?? 0), 0);
        } else {
          // For an image, sum config blob + layer sizes from the manifest.
          const config = body.config as { size?: number; digest?: string } | undefined;
          const layers = (body.layers as Array<{ size?: number }> | undefined) ?? [];
          totalSize = (config?.size ?? 0) + layers.reduce((sum, l) => sum + (l.size ?? 0), 0);
          // Skip the config-blob fetch here to keep the table fast; the
          // ManifestDetail right pane fetches it and shows created/os/arch.
          // Trade-off: the table's "created" column stays empty.
        }

        result.set(tag, {
          isMultiArch: isIndex,
          digest: m.digest,
          digestShort: m.digest.slice(0, 19) + '…',
          totalSize,
          created,
        });
        if (!cancelled) setMetadata(new Map(result));
      } catch {
        // Skip — the row will fall back to its "—" defaults.
      }
    };

    (async () => {
      // Bounded concurrency. Walk the tag list in waves of MAX_CONCURRENT.
      for (let i = 0; i < tags.length; i += MAX_CONCURRENT) {
        if (cancelled) return;
        const batch = tags.slice(i, i + MAX_CONCURRENT);
        await Promise.all(batch.map(fetchTag));
      }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [repo, tags]);

  return { metadata, loading };
}
