// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render tests for the audit-log page's affordances:
 *   - the hash-chain "Verify integrity" button is sysadmin-only
 *   - the "Denied attempts" quick-filter toggles the action filter to
 *     `authz.denied` and clears cleanly
 *   - impersonator / target / group (and, for a sysadmin, org) filters reach
 *     the API — from the URL, and from the ids on a row
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AuditPage from '../pages/dashboard/audit';
import { mockAuthGuard } from './helpers/pageMocks';

const authGuard = mockAuthGuard();

// useAuthGuard is swapped per-test to flip the sysadmin flag.
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

// The page reads router.query for deep-link hydration only.
let routerQuery: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: routerQuery }),
}));

// DashboardLayout drags in providers — reduce it to a passthrough wrapper.
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

const listAuditEvents = jest.fn();
const verifyAuditChain = jest.fn();
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
    groupId: 'grp-dddddddd',
    createdAt: '2026-09-01T00:00:00Z',
  };

  it('hydrates impersonator, target, group and org from the URL for a sysadmin', async () => {
    authGuard.isSuperAdmin = true;
    routerQuery = { impersonatorId: 'op-1', targetId: 'pl-1', groupId: 'grp-1', orgId: 'org-7' };
    render(<AuditPage />);
    await waitFor(() => expect(lastFilters()).toMatchObject({
      impersonatorId: 'op-1', targetId: 'pl-1', groupId: 'grp-1', orgId: 'org-7',
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

    fireEvent.click(screen.getByRole('button', { name: 'group' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ groupId: 'grp-dddddddd' }));

    fireEvent.click(screen.getByRole('button', { name: 'org' }));
    await waitFor(() => expect(lastFilters()).toMatchObject({ orgId: 'org-9' }));
  });

  it('offers to clear filters from the empty state', async () => {
    routerQuery = { groupId: 'grp-1' };
    render(<AuditPage />);
    expect(await screen.findByText(/no matching audit events/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /clear filters/i })[0]);
    await waitFor(() => expect(lastFilters()).not.toHaveProperty('groupId'));
  });
});
