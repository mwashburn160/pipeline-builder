// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform → Runner signing keys (system org): the operator table (status
 * only, never key material) with its filters and org links, the "Pause all
 * pipeline runs" toggle and the per-org emergency revoke — both behind
 * `orgs:manage` and a step-up.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { READ_ONLY_REASON } from '../src/components/ui/ReadOnlyNotice';
import { resolvePageGate } from '../src/lib/page-access';
import RunnerSigningKeysPage from '../pages/dashboard/admin/runner-signing-keys';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, title }: { onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; details?: React.ReactNode; title?: string }) => (
    <div data-testid="stepup-modal">
      <h2>{title}</h2>
      {details}
      <button type="button" onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
    </div>
  ),
}));

const api = {
  listRunnerSigningKeyStatus: jest.fn<AnyFn>(),
  getRunnerDeliveries: jest.fn<AnyFn>(),
  setRunnerDeliveriesPaused: jest.fn<AnyFn>(),
  systemRevokeRunnerSigningKey: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const row = (over: Record<string, unknown> = {}) => ({
  orgId: 'o1', orgName: 'Acme', mode: 'own', inheritedFrom: null, activeKid: 'kid-acme-123456', keyAgeDays: 400,
  rotation: 'none', inTransition: false, overAge: true, unreadable: false, runnerCount: 2, ...over,
});
const ok = (data: unknown) => ({ success: true, data });

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: () => true, isSuperAdmin: true });
  api.listRunnerSigningKeyStatus.mockResolvedValue(ok({
    orgs: [row(), row({ orgId: 'o2', orgName: 'Team A', mode: 'inherit', inheritedFrom: { orgId: 'o1', orgName: 'Acme' }, activeKid: null, keyAgeDays: null, overAge: false, unreadable: true })],
    pagination: { total: 2, limit: 50, offset: 0, hasMore: false },
  }));
  api.getRunnerDeliveries.mockResolvedValue(ok({ paused: false, pausedAt: null, pausedBy: null, reason: null }));
  api.setRunnerDeliveriesPaused.mockResolvedValue(ok({ paused: true, pausedAt: '2026-11-19T00:00:00Z', pausedBy: 'op', reason: 'incident' }));
  api.systemRevokeRunnerSigningKey.mockResolvedValue(ok({ orgId: 'o1', revokedKid: 'kid-acme-123456', activeKid: 'kid-new' }));
});

describe('Runner signing keys (operators)', () => {
  it('is gated on orgs:read in the nav', () => {
    expect(resolvePageGate('/dashboard/admin/runner-signing-keys')).toEqual({ permission: 'orgs:read' });
  });

  it('lists each org: mode, inherited-from, active kid, age with an over-age badge, readability, runners, linking to the org', async () => {
    render(<RunnerSigningKeysPage />);
    expect(await screen.findByText('kid-acme-123456')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Acme' })[0]).toHaveAttribute('href', '/dashboard/admin/orgs/o1');
    expect(screen.getByRole('link', { name: 'Team A' })).toHaveAttribute('href', '/dashboard/admin/orgs/o2');
    expect(screen.getByText('400 days')).toBeInTheDocument();
    expect(screen.getByText('Over age', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Unreadable', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/Inherits/)).toBeInTheDocument();
  });

  it.each([
    ['overAge', { overAge: true }],
    ['pending', { rotation: 'pending' }],
    ['unreadable', { unreadable: true }],
    ['inTransition', { inTransition: true }],
  ])('the %s filter is sent to the server', async (value, query) => {
    render(<RunnerSigningKeysPage />);
    await screen.findByText('kid-acme-123456');
    fireEvent.change(screen.getByLabelText('Filter organizations'), { target: { value } });
    await waitFor(() => expect(api.listRunnerSigningKeyStatus).toHaveBeenLastCalledWith({ ...query, limit: 50, offset: 0 }, expect.anything()));
  });

  it('Pause all pipeline runs: the dialog says every run stops, then PUT with the reason and the step-up token', async () => {
    render(<RunnerSigningKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause all pipeline runs' }));
    const dialog = screen.getByTestId('stepup-modal');
    expect(dialog).toHaveTextContent(/every Run and Stop on the deployment answers 409/);
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'incident' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.setRunnerDeliveriesPaused).toHaveBeenCalledWith({ paused: true, reason: 'incident' }, 'tok'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('All pipeline runs are paused'));
  });

  it('while paused, offers Resume', async () => {
    api.getRunnerDeliveries.mockResolvedValue(ok({ paused: true, pausedAt: '2026-11-19T00:00:00Z', pausedBy: 'op', reason: 'incident' }));
    render(<RunnerSigningKeysPage />);
    expect(await screen.findByRole('button', { name: 'Resume pipeline runs' })).toBeInTheDocument();
    expect(screen.getByTestId('runner-deliveries-state')).toHaveTextContent('Paused');
  });

  it('Revoke key: POST the system-org revoke with the step-up token', async () => {
    render(<RunnerSigningKeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke key' }));
    fireEvent.click(within(screen.getByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.systemRevokeRunnerSigningKey).toHaveBeenCalledWith('o1', { reason: undefined }, 'tok'));
  });

  it('without orgs:manage the writes are disabled', async () => {
    mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: (p: string) => p === 'orgs:read' });
    render(<RunnerSigningKeysPage />);
    const pause = await screen.findByRole('button', { name: 'Pause all pipeline runs' });
    expect(pause.hasAttribute('disabled') || pause.getAttribute('aria-disabled') === 'true').toBe(true);
    const revoke = screen.getByRole('button', { name: 'Revoke key' });
    expect(revoke.hasAttribute('disabled') || revoke.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('a read-only session says so, not "Requires orgs:manage"', async () => {
    mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: (p: string) => p === 'orgs:read', isReadOnly: true });
    render(<RunnerSigningKeysPage />);
    const pause = await screen.findByRole('button', { name: 'Pause all pipeline runs' });
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText(READ_ONLY_REASON).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Requires orgs:manage')).not.toBeInTheDocument();
  });
});
