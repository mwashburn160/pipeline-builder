// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform settings — four tabs, and the defect the tabs fixed.
 *
 * The page had grown to six stacked surfaces across three unrelated jobs (what
 * the deploy is configured to do, whether it is healthy, who is allowed to do
 * what). The split is worth a test for one reason beyond layout: **Consoles and
 * Staffing had been nested inside the summary fetch's guard**, so a slow or
 * failed `GET /admin/summary` hid the only surface that assigns the system org's
 * job Roles. The last two cases here are that regression.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { mockAuthGuard } from './helpers/pageMocks';
import { SYSTEM_ORG_ID } from '../src/lib/constants';
import { clearQueryCache } from '../src/lib/query-cache';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
// The tabs live in the query string (`useUrlTab`), so the page needs a router.
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());

let deployTarget = 'aws-eks';
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ deployTarget, adminConsolesEnabled: true }),
}));
jest.mock('@/hooks/useSessionAssurance', () => ({
  __esModule: true,
  readSessionAssurance: () => 2,
  useSessionAssurance: () => 2,
}));

const getAdminSummary = jest.fn<AnyFn>();
const getOrganizationRoles = jest.fn<AnyFn>();
const getOrganizationMembers = jest.fn<AnyFn>();
const getOncallStatus = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getAdminSummary: (...a: unknown[]) => getAdminSummary(...a),
    getOrganizationRoles: (...a: unknown[]) => getOrganizationRoles(...a),
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
    oncallStatus: (...a: unknown[]) => getOncallStatus(...a),
    addRoleMember: jest.fn(),
    removeRoleMember: jest.fn(),
    ensureFreshToken: jest.fn(),
    getAccessToken: () => null,
  },
}));

import PlatformSettingsPage from '../pages/dashboard/admin/settings';

const SUMMARY = {
  orgs: { total: 7, perOrgKms: 2, ssoEnabled: 3 },
  users: { total: 40, sysadmins: 2 },
  rlsContextMode: 'session',
};

const JOB_ROLES = ['Platform Operator', 'Account Manager', 'Console Administrator', 'Support Agent'];

beforeEach(() => {
  clearQueryCache();
  deployTarget = 'aws-eks';
  mockAuthGuard({ isSuperAdmin: true, user: { id: 'u1', organizationId: SYSTEM_ORG_ID, isSuperAdmin: true } });
  getAdminSummary.mockReset().mockResolvedValue({ success: true, data: SUMMARY });
  getOrganizationRoles.mockReset().mockResolvedValue({
    success: true,
    data: {
      roles: JOB_ROLES.map((name, i) => ({
        id: `r-${i}`, name, grantsRole: 'member', permissions: [], system: true, members: [],
      })),
      pagination: { total: 4, offset: 0, limit: 10, hasMore: false },
    },
  });
  getOrganizationMembers.mockReset().mockResolvedValue({
    success: true, data: { members: [], pagination: { total: 0, offset: 0, limit: 200, hasMore: false } },
  });
  getOncallStatus.mockReset().mockResolvedValue({ success: true, data: { enabled: false, provider: null, routingKeyConfigured: false } });
});

const tab = (name: string) => screen.getByRole('tab', { name });

describe('Platform settings tabs', () => {
  it('opens on Configuration and offers all four tabs', async () => {
    render(<PlatformSettingsPage />);
    for (const name of ['Configuration', 'Posture', 'Consoles', 'Staffing']) {
      expect(tab(name)).toBeInTheDocument();
    }
    expect(tab('Configuration')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
  });

  it('shows only the active tab, so the page is one job at a time', async () => {
    render(<PlatformSettingsPage />);
    await screen.findByText(/Read-only/);
    // Staffing's rosters are not in the document until its tab is chosen.
    expect(screen.queryByText('Support Agent')).not.toBeInTheDocument();
    fireEvent.click(tab('Staffing'));
    expect(await screen.findByText('Support Agent')).toBeInTheDocument();
    expect(screen.queryByText(/Read-only/)).not.toBeInTheDocument();
  });

  it('puts the fleet counts and the on-call posture under Posture', async () => {
    render(<PlatformSettingsPage />);
    fireEvent.click(tab('Posture'));
    expect(await screen.findByText('Orgs')).toBeInTheDocument();
    expect(screen.getByText('SSO enabled')).toBeInTheDocument();
  });

  it('puts the operator consoles under Consoles', async () => {
    render(<PlatformSettingsPage />);
    fireEvent.click(tab('Consoles'));
    expect(await screen.findByText('Operator consoles')).toBeInTheDocument();
  });

  // ── The regression the tabs fixed ───────────────────────────────────────────
  // Consoles and Staffing were nested inside `{summary && …}`. Neither needs the
  // summary — the consoles are a static list and the rosters fetch their own
  // roles — so a failed or pending summary hid them for no reason, and Staffing
  // is the ONLY grant path for a system-org-only permission.
  it('still renders Staffing when the summary fetch FAILS', async () => {
    getAdminSummary.mockResolvedValue({ success: false, message: 'Summary unavailable' });
    render(<PlatformSettingsPage />);
    fireEvent.click(tab('Staffing'));
    expect(await screen.findByText('Platform Operator')).toBeInTheDocument();
    // …and the summary's own failure is not reported on a tab that never used it.
    expect(screen.queryByText(/Summary unavailable/)).not.toBeInTheDocument();
  });

  it('still renders Consoles while the summary is in flight', async () => {
    getAdminSummary.mockReturnValue(new Promise(() => {})); // never settles
    render(<PlatformSettingsPage />);
    fireEvent.click(tab('Consoles'));
    expect(await screen.findByText('Operator consoles')).toBeInTheDocument();
  });

  it('reports a summary failure on the tabs that DO use it', async () => {
    getAdminSummary.mockResolvedValue({ success: false, message: 'Summary unavailable' });
    render(<PlatformSettingsPage />);
    expect(await screen.findByText(/Summary unavailable/)).toBeInTheDocument();
    fireEvent.click(tab('Posture'));
    await waitFor(() => expect(screen.getByText(/Summary unavailable/)).toBeInTheDocument());
  });
});
