// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemAdmin } from '@/lib/auth-helpers';
import type { Dashboard } from '@/types/observability';
import type { User } from '@/types';

/**
 * Whether this viewer may edit (or delete) this dashboard — the same rule
 * ops-center applies per dashboard (`dashboardService.canWrite`; the PUT and
 * DELETE routes name no permission): a system admin may; otherwise never a
 * public dashboard or another org's; its creator may; and a
 * `dashboards:write` holder may for an org-visible one — not another member's
 * private dashboard. A read-only session may not (the creator branch is not
 * read-only-aware the way `can()` is).
 */
export function canEditDashboard(
  dashboard: Pick<Dashboard, 'orgId' | 'createdBy' | 'visibility'>,
  viewer: { user: User | null | undefined; can: (permission: 'dashboards:write') => boolean; isReadOnly: boolean },
): boolean {
  const { user, can, isReadOnly } = viewer;
  if (!user || isReadOnly) return false;
  if (isSystemAdmin(user)) return true;
  if (dashboard.visibility === 'public') return false;
  if (dashboard.orgId !== user.organizationId) return false;
  if (dashboard.createdBy === user.id) return true;
  return dashboard.visibility === 'org' && can('dashboards:write');
}
