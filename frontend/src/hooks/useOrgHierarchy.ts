// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useMemo } from 'react';
import { useAuth } from './useAuth';
import type { UserOrgMembership } from '@/types';

export interface OrgHierarchy {
  /** The active org's membership row, once the org list has loaded. */
  activeOrg: UserOrgMembership | undefined;
  /** The active org is a team nested under a parent (pooled quota/seats/billing). */
  isChildOrg: boolean;
  /** The active org parents at least one live team. */
  hasChildOrgs: boolean;
  /** How many live teams the active org parents (0 when none). */
  childOrgCount: number;
  /** Direct parent of the active org when it is a team. */
  parentOrgId: string | undefined;
  /** Direct parent's display name when it is a team and the name is known. */
  parentOrgName: string | undefined;
  /**
   * The session reaches the active org through INHERITED authority: an admin of
   * its parent, with no membership row of their own here. They are not on this
   * team's roster and consume none of its seats, so any surface that says
   * "your role" / "your team" must say so instead of implying membership.
   */
  viaAncestor: boolean;
  /**
   * The active org's live teams that are also in the session's org list (a
   * parent admin gets a `viaAncestor` row per live team, so for them this is
   * the full set). Use it to put a NAME on a team id a backend rollup returns;
   * never to decide whether hierarchy UI renders — that is `hasChildOrgs`,
   * which counts teams server-side and doesn't depend on membership.
   */
  childOrgs: UserOrgMembership[];
  /** `childOrgs` name for `orgId`, falling back to the id itself. */
  teamName: (orgId: string) => string;
}

/**
 * The active org's place in the org → team hierarchy.
 *
 * The one source for "should hierarchy UI render": team lists, "include child
 * teams" rollup toggles and per-team breakdowns show only when
 * `hasChildOrgs`; "managed by your parent" copy only when `isChildOrg`. Entry
 * points that CREATE the first team (Members → Create team) are the exception —
 * they must stay visible on a flat org.
 *
 * `viaAncestor` is the honesty signal that rides alongside: the session is in a
 * team it has no membership row in, so anything that would imply membership
 * (a roster count, "your role", a seat) has to say where the authority came
 * from instead.
 *
 * Read from the membership list `useAuth` already loads (`childOrgCount` rides
 * on `/user/organizations`), so no page issues its own descendants lookup.
 * Creating a team calls `refreshUser()`, which re-reads the count.
 */
export function useOrgHierarchy(): OrgHierarchy {
  const { user, organizations } = useAuth();
  const activeOrgId = user?.organizationId;
  return useMemo(() => {
    const activeOrg = activeOrgId ? organizations.find((o) => o.id === activeOrgId) : undefined;
    const childOrgCount = activeOrg?.childOrgCount ?? 0;
    const childOrgs = activeOrgId ? organizations.filter((o) => o.parentOrgId === activeOrgId) : [];
    const nameById = new Map(childOrgs.map((o) => [o.id, o.name]));
    return {
      activeOrg,
      isChildOrg: !!activeOrg?.parentOrgId,
      hasChildOrgs: childOrgCount > 0,
      childOrgCount,
      parentOrgId: activeOrg?.parentOrgId,
      parentOrgName: activeOrg?.parentOrgName,
      viaAncestor: !!activeOrg?.viaAncestor,
      childOrgs,
      teamName: (orgId: string) => nameById.get(orgId) ?? orgId,
    };
  }, [activeOrgId, organizations]);
}
