// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for the audit-log page's affordances:
 *   - the hash-chain "Verify integrity" button is sysadmin-only
 *   - the "Denied attempts" quick-filter toggles the action filter to
 *     `authz.denied` and clears cleanly
 *   - impersonator / target / role (and, for a sysadmin, org) filters reach
 *     the API — from the URL, and from the ids on a row
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AuditPage from '../pages/dashboard/audit';
import { mockAuthGuard } from './helpers/pageMocks';

const authGuard = mockAuthGuard();

// useAuthGuard is swapped per-test to flip the sysadmin flag.
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

// `useListPage({ urlSync: true })` hydrates from router.query and mirrors the
// settled state back with a shallow `router.replace`, so the mock needs both.
let routerQuery: Record<string, string> = {};
const routerReplace = jest.fn<AnyFn>();
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: routerQuery, pathname: '/dashboard/audit', replace: (...a: unknown[]) => routerReplace(...a) }),
}));

// DashboardLayout drags in providers — reduce it to a passthrough wrapper.
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

const listAuditEvents = jest.fn<AnyFn>();
const verifyAuditChain = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAuditEvents: (...args: unknown[]) => listAuditEvents(...args),
    verifyAuditChain: (...args: unknown[]) => verifyAuditChain(...args),
  },
}));

beforeEach(() => {
  listAuditEvents.mockReset().mockResolvedValue({
    success: true,
    data: { events: [], pagination: { total: 0, offset: 0, limit: 50, hasMore: false } },
  });
  verifyAuditChain.mockReset();
  routerReplace.mockReset();
  authGuard.isSuperAdmin = false;
  routerQuery = {};
});

/** The filter object of the most recent list call. */
const lastFilters = () => listAuditEvents.mock.calls[listAuditEvents.mock.calls.length - 1][0] as Record<string, unknown>;

describe('AuditPage — verify integrity gating', () => {
  it('shows the Verify integrity button for a sysadmin', async () => {
    authGuard.isSuperAdmin = true;
    render(<AuditPage />);
    expect(await screen.findByRole('button', { name: /verify integrity/i })).toBeInTheDocument();
  });

  it('hides the Verify integrity button for an org-admin', async () => {
    authGuard.isSuperAdmin = false;
    render(<AuditPage />);
    // Wait for the initial fetch to settle (empty-state renders) before asserting absence.
    expect(await screen.findByText(/no matching audit events/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify integrity/i })).not.toBeInTheDocument();
  });

  it('reports an intact chain on a successful verify', async () => {
    authGuard.isSuperAdmin = true;
    verifyAuditChain.mockResolvedValue({ success: true, data: { ok: true, count: 7 } });
    render(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: /verify integrity/i }));
    expect(await screen.findByText(/chain intact \(7 events\)/i)).toBeInTheDocument();
    expect(verifyAuditChain).toHaveBeenCalledWith('org-1');
  });

  it('surfaces a tamper result with the broken-at id', async () => {
    authGuard.isSuperAdmin = true;
    verifyAuditChain.mockResolvedValue({ success: true, data: { ok: false, brokenAt: 'evt-42', count: 3 } });
    render(<AuditPage />);
    fireEvent.click(await screen.findByRole('button', { name: /verify integrity/i }));
    expect(await screen.findByText(/tamper detected/i)).toBeInTheDocument();
    expect(screen.getByText(/evt-42/)).toBeInTheDocument();
  });
});

describe('AuditPage — denied-attempts quick filter', () => {
  it('sets the action filter to authz.denied when toggled on, and clears it when toggled off', async () => {
    render(<AuditPage />);
    const chip = await screen.findByRole('button', { name: /denied attempts/i });
    // The action filter now lives in a collapsible panel (collapsed by default) —
    // open it so the input is mounted and its value is inspectable.
    fireEvent.click(screen.getByRole('button', { name: /^filters$/i }));
    const actionInput = screen.getByPlaceholderText(/filter by action/i) as HTMLInputElement;

    expect(actionInput.value).toBe('');
    fireEvent.click(chip);
    expect(actionInput.value).toBe('authz.denied');
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(chip);
    expect(actionInput.value).toBe('');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('AuditPage — identity filters', () => {
  const event = {
    _id: 'e1',
    action: 'pipeline.update',
    actorId: 'user-aaaaaaaa',
    impersonatorId: 'op-bbbbbbbb',
    orgId: 'org-9',
    targetType: 'pipeline',
    targetId: 'pl-cccccccc',
    roleId: 'role-dddddddd',
    createdAt: '2026-09-01T00:00:00Z',
  };

  it('hydrates impersonator, target, role and org from the URL for a sysadmin', async () => {
    authGuard.isSuperAdmin = true;
    routerQuery = { impersonatorId: 'op-1', targetId: 'pl-1', roleId: 'role-1', orgId: 'org-7' };
    render(<AuditPage />);
    await waitFor(() => expect(lastFilters()).toMatchObject({
      impersonatorId: 'op-1', targetId: 'pl-1', roleId: 'role-1', orgId: 'org-7',
    }));
  });

  it('never sends an org filter for an org admin (the backend pins them)', async () => {
    routerQuery = { orgId: 'org-7', impersonatorId: 'op-1' };
    render(<AuditPage />);
    await waitFor(() => expect(lastFilters()).toMatchObject({ impersonatorId: 'op-1' }));
    expect(lastFilters()).not.toHaveProperty('orgId');
  });

  it('narrows the list from the ids on a row', async () => {
    authGuard.isSuperAdmin = true;
    listAuditEvents.mockResolvedValue({
      success: true,
      data: { events: [event], pagination: { total: 1, offset: 0, limit: 50, hasMore: false } },
    });
    render(<AuditPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'via' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ impersonatorId: 'op-bbbbbbbb', offset: 0 }));

    fireEvent.click(screen.getByRole('button', { name: 'pipeline' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ targetType: 'pipeline', targetId: 'pl-cccccccc' }));

    fireEvent.click(screen.getByRole('button', { name: 'role' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ roleId: 'role-dddddddd' }));

    fireEvent.click(screen.getByRole('button', { name: 'org' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ orgId: 'org-9' }));
  });

  it('never offers the sysadmin-only scopes to an org admin', async () => {
    render(<AuditPage />);
    await screen.findByText(/no matching audit events/i);
    fireEvent.click(screen.getByRole('button', { name: /^filters$/i }));
    expect(screen.queryByLabelText(/filter by org id/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/filter by affected org id/i)).not.toBeInTheDocument();
    // …but does offer every scope the backend honours for them.
    expect(screen.getByLabelText(/filter by actor user id/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter by role id/i)).toBeInTheDocument();
  });

  it('leaves an org admin\u2019s deep-linked org scope out of the filter count', async () => {
    // `useListPage`'s URL hydration is not role-aware, so the value lands in
    // filter state; the page must still treat it as not-in-effect.
    routerQuery = { orgId: 'org-7' };
    render(<AuditPage />);
    await screen.findByText(/no matching audit events/i);
    // A counted filter would badge the toggle, changing its accessible name.
    expect(screen.getByRole('button', { name: /^filters$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it('mirrors the settled filter state back into the URL', async () => {
    render(<AuditPage />);
    await screen.findByText(/no matching audit events/i);
    fireEvent.click(screen.getByRole('button', { name: /denied attempts/i }));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ action: 'authz.denied' }) }),
      undefined,
      { shallow: true },
    ));
  });

  it('offers to clear filters from the empty state', async () => {
    routerQuery = { roleId: 'role-1' };
    render(<AuditPage />);
    expect(await screen.findByText(/no matching audit events/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /clear filters/i })[0]);
    await waitFor(() => expect(lastFilters()).not.toHaveProperty('roleId'));
  });
});
