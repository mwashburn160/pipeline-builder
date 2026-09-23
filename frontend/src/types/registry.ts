// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Image-registry wire shapes for the sysadmin-only registry browser. */

/** One repository entry from /v2/_catalog. */
export interface RegistryRepository { name: string }

/** Tag list for a single repo. `tags` is null when the repo exists but is empty. */
export interface RegistryTagList { name: string; tags: string[] | null }

/** Top-level OCI / Docker v2 manifest envelope. */
export interface RegistryManifest {
  mediaType: string;
  digest: string;
  size: number;
  body: unknown;
}

/** Parsed image config blob (OCI v1 image config spec). The registry now
 *  rejects manifests that omit required OCI fields, so `architecture` and
 *  `os` are guaranteed present. `config` and `history` remain optional per
 *  the spec (a scratch image can have an empty config, etc.). */
export interface RegistryImageConfig {
  created?: string;
  architecture: string;
  os: string;
  config?: { Env?: string[]; Cmd?: string[]; WorkingDir?: string };
  history?: { created: string; created_by?: string }[];
}

/** One platform manifest entry inside an OCI image index. */
export interface RegistryPlatformRef {
  digest: string;
  mediaType: string;
  platform: { os: string; architecture: string; variant?: string };
  size: number;
}

/**
 * Discriminated union of what `useImageDetail` returns:
 * - `image`: single-arch manifest; `config` carries the parsed config blob.
 * - `index`: multi-arch index; `platforms` lists referenced child manifests
 * so the UI can drill into a specific platform.
 * - `unknown`: mediaType isn't one we recognise — JSON viewer only.
 */
export type RegistryManifestKind =
  | { kind: 'image'; manifest: RegistryManifest; config: RegistryImageConfig }
  | { kind: 'index'; manifest: RegistryManifest; platforms: RegistryPlatformRef[] }
  | { kind: 'unknown'; manifest: RegistryManifest; reason: string };

/** Result of a successful `copyImage` call. */
export interface RegistryCopyResult {
  source: string;
  target: string;
  digest: string;
  mounted: { manifests: number; blobs: number };
}

/** Grouped repos for the sidebar list (system first, then `org-*` alphabetical). */
export interface RegistryRepoGroup {
  namespace: 'system' | `org-${string}`;
  repos: RegistryRepository[];
}
