// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry's repository namespaces, as one set of typed predicates. Who may
 * read or write each one is decided elsewhere (repo-access.ts for the images
 * API, token-service.ts for registry tokens); this module only says which
 * namespace a repository is in and whether its name is well-formed.
 *
 * - `org-<orgId>/…` — an org's own images (plugin builds included);
 * - `system/…` — the system org's images (base images, Official plugin builds);
 * - `library/…` — shared base images;
 * - `public/<publisherHandle>/<name>` — listed plugin versions (append-only);
 * - `quarantine/<submissionId>` — an anonymous submission's build;
 * - `registry-meta/…` — this service's own bookkeeping.
 */

import { SYSTEM_ORG_ID } from '@pipeline-builder/api-core';

export const PUBLIC_PREFIX = 'public/';
export const QUARANTINE_PREFIX = 'quarantine/';
export const REGISTRY_META_PREFIX = 'registry-meta/';
export const SYSTEM_PREFIX = 'system/';
export const LIBRARY_PREFIX = 'library/';

/** In the `public/*` namespace (by prefix; see {@link isPublicRepository} for the full shape). */
export const inPublicNamespace = (repo: string): boolean => repo.startsWith(PUBLIC_PREFIX);
/** In the `quarantine/*` namespace (by prefix; see {@link isQuarantineRepository} for the full shape). */
export const inQuarantineNamespace = (repo: string): boolean => repo.startsWith(QUARANTINE_PREFIX);
export const inRegistryMetaNamespace = (repo: string): boolean => repo.startsWith(REGISTRY_META_PREFIX);
export const inSystemNamespace = (repo: string): boolean => repo.startsWith(SYSTEM_PREFIX);
export const inLibraryNamespace = (repo: string): boolean => repo.startsWith(LIBRARY_PREFIX);

const ORG_REPO_PREFIX = /^org-([a-z0-9][a-z0-9-]*)\//;

/** The owning org id of an `org-<id>/...` repo, or null for shared namespaces. */
export function repoTenant(repo: string): string | null {
  const m = repo.match(ORG_REPO_PREFIX);
  return m ? m[1] : null;
}

/**
 * The org that OWNS `repo` — the org id of an `org-<id>/...` repo, the system org
 * for `system/...` and for `quarantine/...` (moderation is the system org's
 * decision, so only a system-org service token may sign or publish from it) —
 * or undefined for org-less shared namespaces (`library/...`, anything
 * unrecognized). Used as the audit `affectedOrgId`.
 */
export function repoOwnerOrgId(repo: string): string | undefined {
  const tenant = repoTenant(repo);
  if (tenant !== null) return tenant;
  return inSystemNamespace(repo) || inQuarantineNamespace(repo) ? SYSTEM_ORG_ID : undefined;
}

/**
 * A publisher handle / plugin name as ONE registry path component (the
 * Distribution grammar: lowercase alphanumerics joined by `.`, `_`, `__` or
 * runs of `-`).
 */
export const PUBLISHER_HANDLE_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const PLUGIN_NAME_PATTERN = '[a-z0-9][a-z0-9._-]*';
/**
 * Plugin repositories that are signed: a build's private copy (`system/<name>`,
 * `org-<orgId>/<name>`), an anonymous submission's quarantined build
 * (`quarantine/<submissionId>` — signed so its SBOM attestation can be carried
 * into `public/community/<name>` on approval), or a listed version's public
 * copy (`public/<publisherHandle>/<name>`).
 */
const PLUGIN_REPO_RE = new RegExp(
  `^(system|org-[a-z0-9]+|quarantine|public/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)/${PLUGIN_NAME_PATTERN}$`,
);
/** `quarantine/<submissionId>` — one lowercase path component (a submission uuid). */
const QUARANTINE_REPO_RE = /^quarantine\/[a-z0-9][a-z0-9-]{0,127}$/;
const PUBLIC_REPO_RE = new RegExp(`^public/([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)/(${PLUGIN_NAME_PATTERN})$`);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function isPluginRepository(repository: string): boolean {
  return PLUGIN_REPO_RE.test(repository);
}

/** True for an anonymous submission's `quarantine/<submissionId>` repository. */
export function isQuarantineRepository(repository: string): boolean {
  return QUARANTINE_REPO_RE.test(repository);
}

/** True for a `public/<publisherHandle>/<name>` repository. */
export function isPublicRepository(repository: string): boolean {
  return PUBLIC_REPO_RE.test(repository);
}

/** `{ handle, name }` of a `public/<handle>/<name>` repository, or null. */
export function parsePublicRepository(repository: string): { handle: string; name: string } | null {
  const m = PUBLIC_REPO_RE.exec(repository);
  return m ? { handle: m[1], name: m[2] } : null;
}

export function isSha256Digest(digest: string): boolean {
  return DIGEST_RE.test(digest);
}
