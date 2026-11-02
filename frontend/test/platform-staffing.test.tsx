// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform staffing — the surface that assigns the system org's job Roles.
 *
 * Every permission behind those Roles is system-org-only, so a superadmin
 * assigning a seeded Role is the ONLY grant path that exists. This suite pins
 * the three things that make the surface worth having:
 *
 *  1. The Role NAMES match what `seedDefaultRoles` seeds. They are matched by
 *     name because ids are per-install, so a rename on either side would show
 *     "Role not found" and the grant path would silently vanish.
 *  2. A superadmin can add and remove; any other holder sees the roster
 *     read-only, mirroring `RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`.
 *  3. Super Admin is NOT assignable here — it goes through the grants route with
 *     a second-factor step-up, and a dropdown beside four job Roles would make
 *     manufacturing another operator look routine.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { PlatformStaffingPanel } from '../src/components/admin/PlatformStaffingPanel';
import { SYSTEM_ORG_JOB_ROLES } from '../src/lib/system-org-roles';
import { SYSTEM_ORG_ID } from '../src/lib/constants';
import { clearQueryCache } from '../src/lib/query-cache';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getOrganizationRoles = jest.fn<AnyFn>();
const getOrganizationMembers = jest.fn<AnyFn>();
const addRoleMember = jest.fn<AnyFn>();
const removeRoleMember = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a),
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    addRoleMember: (...a: unknown[]) => addRoleMember(...a),
    removeRoleMember: (...a: unknown[]) => removeRoleMember(...a),
  },
}));

const holder = { id: 'u-op', username: 'opsy', email: 'ops@example.com' };
const candidate = { id: 'u-new', username: 'newbie', email: 'new@example.com' };

/** The system org's Role list, with `holders` on every job Role. */
const rolesResponse = (members: Array<typeof holder> = [holder]) => ({
  success: true,
  data: {
    roles: [
      { id: 'r-admin', name: 'Admin', grantsRole: 'admin', permissions: [], system: true, members: [] },
      { id: 'r-sa', name: 'Super Admin', grantsRole: 'superadmin', permissions: [], system: true, members: [holder] },
      ...SYSTEM_ORG_JOB_ROLES.map((r, i) => ({
        id: `r-${i}`, name: r.name, grantsRole: 'member', permissions: [], system: true, members,
      })),
    ],
    pagination: { total: 6, offset: 0, limit: 10, hasMore: false },
  },
});

beforeEach(() => {
  clearQueryCache();
  getOrganizationRoles.mockReset().mockResolvedValue(rolesResponse());
  getOrganizationMembers.mockReset().mockResolvedValue({
    success: true,
    data: { members: [holder, candidate], pagination: { total: 2, offset: 0, limit: 200, hasMore: false } },
  });
  addRoleMember.mockReset().mockResolvedValue({ success: true, data: {} });
  removeRoleMember.mockReset().mockResolvedValue({ success: true, data: {} });
});

describe('the job-Role list matches what the platform seeds', () => {
  // The names ARE the contract: `SystemOrgRoleRoster` finds its Role by name,
  // because Role ids are seeded per install. A rename on the platform side with
  // no change here turns every roster into "Role not found" — the grant path
  // disappears and nothing else complains.
  it('names exactly the seven job Roles, and never Super Admin', () => {
    expect(SYSTEM_ORG_JOB_ROLES.map((r) => r.name)).toEqual([
      'Platform Observer', 'Platform Operator', 'Account Manager', 'Console Administrator',
      'Support Agent', 'Support Lead', 'Registry Operator',
    ]);
    expect(SYSTEM_ORG_JOB_ROLES.map((r) => r.name)).not.toContain('Super Admin');
    // Ecosystem Manager is a job Role too, but its roster lives on the Ecosystem
    // console beside the queue it governs.
    expect(SYSTEM_ORG_JOB_ROLES.map((r) => r.name)).not.toContain('Ecosystem Manager');
  });

  it('says what each job is and what it costs for nobody to hold it', () => {
    for (const r of SYSTEM_ORG_JOB_ROLES) {
      expect(r.description.length).toBeGreaterThan(40);
      expect(r.emptyDescription.length).toBeGreaterThan(20);
    }
  });
});

describe('PlatformStaffingPanel', () => {
  it('renders a roster per job Role, with its holders', async () => {
    render(<PlatformStaffingPanel isSuperAdmin canWrite />);
    for (const r of SYSTEM_ORG_JOB_ROLES) {
      expect(await screen.findByText(r.name)).toBeInTheDocument();
    }
    // One row per Role for the same holder.
    await waitFor(() => expect(screen.getAllByText('opsy')).toHaveLength(SYSTEM_ORG_JOB_ROLES.length));
    expect(getOrganizationRoles).toHaveBeenCalledWith(SYSTEM_ORG_ID, undefined, expect.anything());
  });

  // The fixture ids are positional (`r-<index>` over SYSTEM_ORG_JOB_ROLES), so
  // resolve the index by NAME — adding a Role to the list used to shift every
  // assertion below it and fail with a confusing off-by-one.
  const roleIndex = (name: string): number => {
    const i = SYSTEM_ORG_JOB_ROLES.findIndex((r) => r.name === name);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('adds a member to one Role through the ordinary role-membership route', async () => {
    render(<PlatformStaffingPanel isSuperAdmin canWrite />);
    const i = roleIndex('Support Agent');
    const picker = await screen.findByLabelText('System-organization member to add to Support Agent');
    fireEvent.change(picker, { target: { value: candidate.id } });
    fireEvent.click(screen.getAllByRole('button', { name: /^Add$/ })[i]);
    await waitFor(() => expect(addRoleMember).toHaveBeenCalledWith(SYSTEM_ORG_ID, `r-${i}`, { userId: candidate.id }));
  });

  it('removes a holder', async () => {
    render(<PlatformStaffingPanel isSuperAdmin canWrite />);
    const i = roleIndex('Platform Operator');
    const btn = await screen.findByRole('button', { name: 'Remove opsy from Platform Operator' });
    fireEvent.click(btn);
    await waitFor(() => expect(removeRoleMember).toHaveBeenCalledWith(SYSTEM_ORG_ID, `r-${i}`, holder.id));
  });

  // Mirrors the backend's `RL_SYSTEM_ORG_ROLE_REQUIRES_SUPERADMIN`: an admin or
  // owner of the SYSTEM org is refused too, so the buttons must not be offered.
  it('is read-only for a non-superadmin, and fetches no candidate list', async () => {
    render(<PlatformStaffingPanel isSuperAdmin={false} canWrite />);
    expect(await screen.findByText('Platform Operator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(getOrganizationMembers).not.toHaveBeenCalled();
  });

  // A read-only impersonation session: the backend rejects every non-GET, so an
  // enabled control would dead-end on a 403.
  it('is read-only during a read-only impersonation even for a superadmin', async () => {
    render(<PlatformStaffingPanel isSuperAdmin canWrite={false} />);
    expect(await screen.findByText('Platform Operator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument();
  });

  it('says so when a Role is missing rather than silently showing nothing', async () => {
    getOrganizationRoles.mockResolvedValue({
      success: true,
      data: { roles: [{ id: 'r-admin', name: 'Admin', grantsRole: 'admin', permissions: [], system: true, members: [] }], pagination: { total: 1, offset: 0, limit: 10, hasMore: false } },
    });
    render(<PlatformStaffingPanel isSuperAdmin canWrite />);
    await waitFor(() => expect(screen.getAllByText('Role not found')).toHaveLength(SYSTEM_ORG_JOB_ROLES.length));
  });

  it('names what nobody holding a Role costs', async () => {
    getOrganizationRoles.mockResolvedValue(rolesResponse([]));
    render(<PlatformStaffingPanel isSuperAdmin canWrite />);
    expect(await screen.findByText(SYSTEM_ORG_JOB_ROLES[0].emptyDescription)).toBeInTheDocument();
  });
});
