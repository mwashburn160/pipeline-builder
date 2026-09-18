// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Role NAME display, a UI-only concern (the permission catalog itself now comes
 * straight from `@pipeline-builder/api-core/permissions`).
 *
 * The built-in Roles are seeded (and existing docs migrated at boot) with their
 * canonical names — `Admin`, `Member`, `Super Admin` — so no remapping is
 * normally needed. This map is a defensive fallback that only rewrites the
 * pre-rename LEGACY names, in case a Role is read before the startup migration
 * has renamed it. Custom Roles pass through unchanged.
 */
const LEGACY_ROLE_NAMES: Record<string, string> = {
  Administrators: 'Admin',
  Developers: 'Member',
  Superadmins: 'Super Admin',
};

/** Display label for a Role name (canonical names pass through; legacy names softened). */
export function roleDisplayName(name: string): string {
  return LEGACY_ROLE_NAMES[name] ?? name;
}
