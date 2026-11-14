// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The coarse per-org membership role (`owner` / `admin` / `member`), keyed by
 * its wire id: the label people read and the badge colour every roster uses.
 *
 * One table because the badge was written four times and disagreed — three
 * rosters coloured `admin` purple and left `owner` grey (indistinguishable from
 * a plain member), while the sysadmin roster coloured `admin` blue. Keyed by
 * api-core's `OrgRole` (`ORG_ROLES`), so a role added on the wire is a compile
 * error here and in every exhaustive consumer.
 */

import { ORG_ROLES, type OrgRole } from '@pipeline-builder/api-core/wire-vocabulary';
import type { BadgeColor } from '@/components/ui/Badge';
import type { RoleGrant } from '@/types';

export const ORG_ROLE_META = {
  member: { label: 'Member', color: 'gray' },
  admin: { label: 'Admin', color: 'purple' },
  owner: { label: 'Owner', color: 'indigo' },
} as const satisfies Record<OrgRole, { label: string; color: BadgeColor }>;

/** Every role, least privileged first (the order a role picker offers them) — api-core's list, reversed. */
export const ORG_ROLE_IDS: readonly OrgRole[] = [...ORG_ROLES].reverse();

/** Badge colour for a role off the wire; an unrecognised one is neutral. */
export function orgRoleColor(role: string): BadgeColor {
  return Object.hasOwn(ORG_ROLE_META, role) ? ORG_ROLE_META[role as OrgRole].color : 'gray';
}

/**
 * The coarse grant a permission Role carries (api-core `ROLE_GRANTS`): its badge
 * colour — superadmin is the loudest — and the one-line summary a system Role
 * shows in place of a permission count.
 */
export const ROLE_GRANT_META = {
  superadmin: { color: 'red', summary: 'grants platform admin' },
  admin: { color: 'purple', summary: 'grants org admin' },
  member: { color: 'gray', summary: 'standard access' },
} as const satisfies Record<RoleGrant, { color: BadgeColor; summary: string }>;
