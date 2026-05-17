// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type {
  RegistryManifestKind,
  RegistryImageConfig,
  RegistryPlatformRef,
} from '@/types';

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

const IMAGE_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);

/**
 * Fetch a manifest and dispatch on its mediaType:
 *  - **image**: also fetches the config blob so the summary tab can render
 *    created / os / arch / env / cmd / history.
 *  - **index**: parses the `manifests[]` array into platform refs so the UI
 *    can drill into a specific platform.
 *  - **unknown**: surfaces a reason; UI shows raw JSON only.
 *
 * Rapid switches between selected tags are safe — each `reference` change
 * triggers an AbortController that cancels in-flight requests for the
 * previous tag.
 */
export function useImageDetail(name: string | null, reference: string | null) {
  const [kind, setKind] = useState<RegistryManifestKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!name || !reference) {
      setKind(null);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const manifestRes = await api.getImageManifest(name, reference);
        if (ctrl.signal.aborted) return;
        const manifest = manifestRes.data;
        if (!manifest) {
          setKind(null);
          setLoading(false);
          return;
        }

        if (INDEX_MEDIA_TYPES.has(manifest.mediaType)) {
          const body = manifest.body as { manifests?: RegistryPlatformRef[] };
          setKind({ kind: 'index', manifest, platforms: body.manifests ?? [] });
          setLoading(false);
          return;
        }

        if (IMAGE_MEDIA_TYPES.has(manifest.mediaType)) {
          const body = manifest.body as { config?: { digest?: string } };
          const configDigest = body.config?.digest;
          if (!configDigest) {
            // Legacy manifest with no config blob — still treat as image.
            setKind({ kind: 'image', manifest, config: {} });
            setLoading(false);
            return;
          }
          try {
            const cfg = await api.getImageBlob(name, configDigest);
            if (ctrl.signal.aborted) return;
            setKind({ kind: 'image', manifest, config: cfg as RegistryImageConfig });
          } catch (blobErr) {
            // Blob too large or unfetchable — degrade to image with empty config.
            // Summary tab will show "Config blob unavailable" + JSON tab still works.
            if (ctrl.signal.aborted) return;
            setKind({ kind: 'image', manifest, config: {} });
          }
          setLoading(false);
          return;
        }

        setKind({
          kind: 'unknown',
          manifest,
          reason: `Unrecognized media type: ${manifest.mediaType}`,
        });
        setLoading(false);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err as Error);
        setLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [name, reference]);

  return { kind, loading, error };
}
