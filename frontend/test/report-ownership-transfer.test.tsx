// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Transferring a report's ownership from the UI.
 *
 * WHY THIS SUITE EXISTS. Ownership is not cosmetic: a scheduled run is authorized AS the
 * definition's owner, so when the owner leaves or loses `reports:author`, the scheduler
 * pauses the report. Two of the three pause reasons tell the admin, in the banner, to
 * TRANSFER it — and for a while the UI had no transfer control at all, so its own
 * remediation advice was impossible to follow. The `Resume` button beside it was not a
 * substitute and was worse than nothing: the scheduler re-checks authority on every run,
 * so resuming without transferring re-pauses on the next tick with the same message.
 *
 * So these tests pin the ROUTE OUT of a paused report, not the dialog's cosmetics:
 *  - the control exists and is reachable from the row that shows the pause;
 *  - the banner's instruction and the available controls agree;
 *  - the current owner cannot be picked (a no-op that still leaves it paused);
 *  - the server's refusal is shown in the server's own words, because the server —
 *    not this dialog — decides who may own a report, and it fails closed;
 *  - the list re-reads after a transfer, so the new owner is visible.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const listReportDefinitions = jest.fn<AnyFn>();
const listReportRecipients = jest.fn<AnyFn>();
const getReportPolicy = jest.fn<AnyFn>();
const getReportDeliveryStatus = jest.fn<AnyFn>();
const transferReportOwnership = jest.fn<AnyFn>();
const getOrganizationMembers = jest.fn<AnyFn>();

// The tab links its inner panel with `?panel=` via useUrlTab, so it needs a router.
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({
  isReady: true, query: {}, pathname: '/dashboard/reports', replace: jest.fn<AnyFn>(),
})));

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listReportDefinitions: (...a: unknown[]) => listReportDefinitions(...a),
    listReportRecipients: (...a: unknown[]) => listReportRecipients(...a),
    getReportPolicy: (...a: unknown[]) => getReportPolicy(...a),
    getReportDeliveryStatus: (...a: unknown[]) => getReportDeliveryStatus(...a),
    transferReportOwnership: (...a: unknown[]) => transferReportOwnership(...a),
    getOrganizationMembers: (...a: unknown[]) => getOrganizationMembers(...a),
  },
}));

// The roster goes through the query cache; only the fetch underneath it is stubbed, so
// the dialog exercises the real hook path.
jest.mock('@/lib/query-cache', () => ({
  __esModule: true,
  runQuery: (q: { run: (s?: AbortSignal) => Promise<unknown> }, o?: { signal?: AbortSignal }) => q.run(o?.signal),
}));

import { StakeholderTab } from '@/components/reports/tabs/StakeholderTab';

const OWNER = 'user-lead';

const definition = (over: Record<string, unknown> = {}) => ({
  id: 'def-1',
  name: 'Weekly delivery',
  template: 'weekly_delivery',
  sections: ['success_rate'],
  cadence: 'weekly',
  timezone: 'UTC',
  weekStart: 'monday',
  scope: { kind: 'org' },
  recipients: [],
  autoSend: false,
  isActive: true,
  pausedReason: null,
  ownerId: OWNER,
  nextRunAt: null,
  lastRunAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...over,
});

const member = (id: string, username: string, role = 'member') => ({
  id, username, email: `${username}@acme.test`, role,
  isOwner: false, isActive: true, isEmailVerified: true, createdAt: '2026-01-01T00:00:00Z',
});

const renderTab = (over: Record<string, unknown> = {}) => render(
  <StakeholderTab
    enabled
    orgId="acme"
    canAuthor
    canShare
    canRollup={false}
    canAdmin
    onStatus={jest.fn<AnyFn>()}
    {...over}
  />,
);

beforeEach(() => {
  jest.clearAllMocks();
  listReportDefinitions.mockResolvedValue({ success: true, data: { definitions: [definition()] } });
  listReportRecipients.mockResolvedValue({ success: true, data: { recipients: [] } });
  getReportPolicy.mockResolvedValue({ success: true, data: { policy: { externalSharing: false, recipientDomains: null, requireApproval: true } } });
  getReportDeliveryStatus.mockResolvedValue({ success: true, data: { emailEnabled: true } });
  getOrganizationMembers.mockResolvedValue({
    data: { members: [member(OWNER, 'lead'), member('user-new', 'newowner'), member('user-adm', 'admin', 'admin')] },
  });
  transferReportOwnership.mockResolvedValue({ success: true, data: { definition: definition({ ownerId: 'user-new' }) } });
});

describe('the transfer control', () => {
  it('is offered on the definition row for someone who can author', async () => {
    renderTab();
    expect(await screen.findByTestId('report-transfer-def-1')).toBeTruthy();
  });

  it('is NOT offered to someone who cannot author', async () => {
    renderTab({ canAuthor: false });
    await screen.findByText('Weekly delivery');
    // Ownership is an authoring act; offering a control that would 403 is a worse
    // experience than not offering it.
    expect(screen.queryByTestId('report-transfer-def-1')).toBeNull();
  });

  it('is reachable on a report paused because its owner left', async () => {
    listReportDefinitions.mockResolvedValue({
      success: true,
      data: { definitions: [definition({ isActive: false, pausedReason: 'owner_inactive' })] },
    });
    renderTab();
    // The banner says to transfer it. The control it names has to be on screen with it,
    // or the advice is unfollowable — which is exactly the bug this suite exists for.
    expect(await screen.findByText(/Transfer it to someone who does/i)).toBeTruthy();
    expect(screen.getByTestId('report-transfer-def-1')).toBeTruthy();
  });

  it('is reachable on a report paused because its owner lost permission', async () => {
    listReportDefinitions.mockResolvedValue({
      success: true,
      data: { definitions: [definition({ isActive: false, pausedReason: 'permission_lost' })] },
    });
    renderTab();
    expect(await screen.findByText(/Transfer it, or restore their permission/i)).toBeTruthy();
    expect(screen.getByTestId('report-transfer-def-1')).toBeTruthy();
  });
});

describe('the transfer dialog', () => {
  const open = async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('report-transfer-def-1'));
    return screen.findByTestId('report-transfer-owner');
  };

  /** The dialog's confirm, scoped so the row's own "Transfer" button can't match. */
  const confirm = () =>
    within(screen.getByRole('dialog')).getByRole('button', { name: /^transfer$/i });

  it('lists the other active members and excludes the current owner', async () => {
    const select = await open();
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('newowner'))).toBe(true);
    // Transferring to the current owner is a no-op that still spends an audit event and
    // still leaves the report paused.
    expect(labels.some((l) => l.includes('lead@acme.test'))).toBe(false);
  });

  it('will not submit until a member is chosen', async () => {
    await open();
    fireEvent.click(confirm());
    expect(transferReportOwnership).not.toHaveBeenCalled();
  });

  it('transfers to the chosen member and re-reads the list', async () => {
    const select = await open();
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'user-new' } });
    fireEvent.click(confirm());
    await waitFor(() => expect(transferReportOwnership).toHaveBeenCalledWith('def-1', 'user-new'));
    // Re-read, so the row shows the new owner instead of stale state that would make a
    // successful transfer look like it did nothing.
    await waitFor(() => expect(listReportDefinitions.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows the SERVER\'s refusal, because the server decides who may own a report', async () => {
    const refusal = 'That user cannot own a report in this organization — they need to be an active member with permission to author reports.';
    transferReportOwnership.mockRejectedValue(Object.assign(new Error(refusal), { statusCode: 400 }));
    const select = await open();
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'user-new' } });
    fireEvent.click(confirm());
    // Verbatim: this dialog cannot see per-member permissions, so paraphrasing would be a
    // second, wrong copy of a rule that is checked against platform and fails closed.
    expect(await screen.findByText(refusal)).toBeTruthy();
  });

  it('says so plainly when there is nobody to transfer to', async () => {
    getOrganizationMembers.mockResolvedValue({ data: { members: [member(OWNER, 'lead')] } });
    renderTab();
    fireEvent.click(await screen.findByTestId('report-transfer-def-1'));
    // An empty picker with no explanation reads as a broken dialog.
    expect(await screen.findByTestId('report-transfer-empty')).toBeTruthy();
  });

  it('survives a roster the API could not return', async () => {
    getOrganizationMembers.mockRejectedValue(new Error('platform down'));
    renderTab();
    fireEvent.click(await screen.findByTestId('report-transfer-def-1'));
    expect(await screen.findByText(/Could not load the member list/i)).toBeTruthy();
  });
});
