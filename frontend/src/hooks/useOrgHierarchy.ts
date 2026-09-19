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
    return {
      activeOrg,
      isChildOrg: !!activeOrg?.parentOrgId,
      hasChildOrgs: childOrgCount > 0,
      childOrgCount,
      parentOrgId: activeOrg?.parentOrgId,
    };
  }, [activeOrgId, organizations]);
}
