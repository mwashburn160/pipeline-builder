// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * cosign stores a plugin image's signature and SBOM attestation as TAGS beside
 * it — `sha256-<hex>.sig` / `sha256-<hex>.att` (see api/plugin supply-chain).
 * They are metadata about another manifest, not images: hidden from tag
 * listings, and deleted along with the manifest they describe so a delete
 * doesn't strand them (or leave a repo "non-empty" with nothing runnable in it).
 */
const COSIGN_COMPANION_TAG_RE = /^sha256-[0-9a-f]{64}\.(sig|att)$/;

export function isCosignCompanionTag(tag: string): boolean {
  return COSIGN_COMPANION_TAG_RE.test(tag);
}

/** The companion tags cosign would have written for `digest` (`sha256:<hex>`). */
export function cosignCompanionTags(digest: string): string[] {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) return [];
  return [`sha256-${match[1]}.sig`, `sha256-${match[1]}.att`];
}
