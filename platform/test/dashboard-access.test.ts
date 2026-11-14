// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL dashboard access decisions — `DashboardService.canRead` /
 * `canWrite` over visibility × caller. The controller suites stub these to
 * `true`, so without this table nothing pins the visibility ladder itself.
 */

import { describe, it, expect } from '@jest/globals';

process.env.SECRET_ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'dashboard-access-test-secret';
process.env.MONGODB_URI ||= 'mongodb://stub:27017/test';

const { dashboardService } = await import('../src/services/dashboard-service.js');

type Visibility = 'public' | 'org' | 'private';
const dash = (visibility: Visibility) => ({
  id: 'dash-1', orgId: 'org-a', createdBy: 'creator', visibility,
}) as unknown as Parameters<typeof dashboardService.canRead>[0];

const CALLERS = {
  creator: { orgId: 'org-a', userId: 'creator', isSuperAdmin: false, isOrgAdmin: false },
  sameOrgMember: { orgId: 'org-a', userId: 'member', isSuperAdmin: false, isOrgAdmin: false },
  sameOrgAdmin: { orgId: 'org-a', userId: 'admin', isSuperAdmin: false, isOrgAdmin: true },
  otherOrgAdmin: { orgId: 'org-b', userId: 'stranger', isSuperAdmin: false, isOrgAdmin: true },
  sysadmin: { orgId: 'system', userId: 'root', isSuperAdmin: true, isOrgAdmin: false },
} as const;
type Caller = keyof typeof CALLERS;

//                     visibility   caller           read   write
const TABLE: Array<[Visibility, Caller, boolean, boolean]> = [
  ['public', 'creator', true, false],
  ['public', 'sameOrgMember', true, false],
  ['public', 'sameOrgAdmin', true, false],
  ['public', 'otherOrgAdmin', true, false],
  ['public', 'sysadmin', true, true],

  ['org', 'creator', true, true],
  ['org', 'sameOrgMember', true, false],
  ['org', 'sameOrgAdmin', true, true],
  ['org', 'otherOrgAdmin', false, false],
  ['org', 'sysadmin', true, true],

  ['private', 'creator', true, true],
  ['private', 'sameOrgMember', false, false],
  ['private', 'sameOrgAdmin', false, false],
  ['private', 'otherOrgAdmin', false, false],
  ['private', 'sysadmin', true, true],
];

describe('dashboard access ladder', () => {
  it.each(TABLE)('%s dashboard, %s → read %s, write %s', (visibility, caller, read, write) => {
    expect(dashboardService.canRead(dash(visibility), CALLERS[caller])).toBe(read);
    expect(dashboardService.canWrite(dash(visibility), CALLERS[caller])).toBe(write);
  });
});
