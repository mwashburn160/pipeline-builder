// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tag names treated as mutable "floating" pointers that operators re-point at
 * a known-good build (which may be an OLD build). A digest carrying one of
 * these tags is never deleted by the registry's own sweeps, nor by a
 * `system/<name>` collection the plugin service hands over.
 * Override the set via `REGISTRY_GC_PROTECTED_TAGS` (comma-separated).
 */
export const DEFAULT_PROTECTED_TAGS = [
  'latest', 'stable', 'main', 'master', 'release', 'prod', 'production', 'edge',
];

/** The protected tag names in force (lowercased). */
export function protectedTagNames(): Set<string> {
  const raw = process.env.REGISTRY_GC_PROTECTED_TAGS;
  const names = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PROTECTED_TAGS;
  return new Set(names.map((n) => n.toLowerCase()));
}
