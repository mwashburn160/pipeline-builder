// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform → Cascade outbox (system org): every downstream leg of an org purge
 * or a user erasure, read with `platform:read`, and the Redrive of a dead or
 * stuck leg — `orgs:manage` plus a step-up, audited `admin.cascade.redrive`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import { resolvePageGate } from '../src/lib/page-access';
import { ApiError } from '../src/lib/api/errors';
import { NAV_SECTIONS } from '../src/lib/nav';
import CascadePage from '../pages/dashboard/admin/cascade';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, title, requireStrongFactor }: {
    onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; details?: React.ReactNode; title?: string; requireStrongFactor?: boolean;
  }) => (
    <div data-testid="stepup-modal" data-strong={requireStrongFactor ? 'yes' : 'no'}>
      <h2>{title}</h2>
      {details}
      <button type="button" onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
    </div>
  ),
}));

const api = {
  listCascadeLegs: jest.fn<AnyFn>(),
  redriveCascadeLeg: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const leg = (over: Record<string, unknown> = {}) => ({
  id: 'leg-dead', kind: 'org.deleted', subjectId: 'org-gone', service: 'pipeline', status: 'dead', attempts: 12,
  nextAttemptAt: '2026-11-20T00:00:00Z', lastError: 'connect ECONNREFUSED', lastStatusCode: 503,
  completedAt: '2026-11-20T00:00:00Z', createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', ...over,
});
const ok = (data: unknown, message?: string) => ({ success: true, data, ...(message ? { message } : {}) });
const page = (legs: unknown[]) => ok({ legs, pagination: { total: legs.length, limit: 50, offset: 0, hasMore: false } });

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: () => true, isSuperAdmin: true });
  api.listCascadeLegs.mockResolvedValue(page([
    leg(),
    leg({ id: 'leg-done', kind: 'user.erased', subjectId: 'user-9', service: 'message', status: 'done', attempts: 1, lastError: null, lastStatusCode: null }),
  ]));
  api.redriveCascadeLeg.mockResolvedValue(ok({ leg: leg({ status: 'pending', attempts: 0 }) }, 'Cascade leg to pipeline queued for redelivery'));
});

const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement;

describe('Cascade outbox (operators)', () => {
  it('reads with platform:read, from the Platform nav, system org only', () => {
    expect(resolvePageGate('/dashboard/admin/cascade')).toEqual({ permission: 'platform:read' });
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === '/dashboard/admin/cascade');
    expect(item).toMatchObject({ title: 'Cascade outbox', requiredPermission: 'platform:read', systemOrgOnly: true });
  });

  it('lists each leg: kind, subject, service, state, attempts, last error with its status, timestamps', async () => {
    render(<CascadePage />);
    const dead = await rowOf('org-gone');
    expect(within(dead).getByText('Org purge')).toBeInTheDocument();
    expect(within(dead).getByText('pipeline')).toBeInTheDocument();
    expect(within(dead).getByText('Dead')).toBeInTheDocument();
    expect(within(dead).getByText('12')).toBeInTheDocument();
    expect(within(dead).getByText(/HTTP 503/)).toBeInTheDocument();
    expect(within(dead).getByText(/connect ECONNREFUSED/)).toBeInTheDocument();
    const done = await rowOf('user-9');
    expect(within(done).getByText('User erasure')).toBeInTheDocument();
    expect(within(done).getByText('Done')).toBeInTheDocument();
    expect(api.listCascadeLegs).toHaveBeenCalledWith({ limit: 50, offset: 0 }, expect.anything());
  });

  it('sends the state, kind and subject filters to the server', async () => {
    render(<CascadePage />);
    await rowOf('org-gone');
    fireEvent.change(screen.getByLabelText('Filter by state'), { target: { value: 'dead' } });
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenLastCalledWith({ status: 'dead', limit: 50, offset: 0 }, expect.anything()));
    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'user.erased' } });
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenLastCalledWith({ status: 'dead', kind: 'user.erased', limit: 50, offset: 0 }, expect.anything()));
    fireEvent.change(screen.getByLabelText('Subject id'), { target: { value: ' org-gone ' } });
    fireEvent.submit(screen.getByLabelText('Subject id').closest('form') as HTMLFormElement);
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenLastCalledWith(
      { status: 'dead', kind: 'user.erased', subjectId: 'org-gone', limit: 50, offset: 0 }, expect.anything()));
  });

  it('a load failure is a retryable error, not an empty table', async () => {
    api.listCascadeLegs.mockRejectedValue(new Error('platform down'));
    render(<CascadePage />);
    expect(await screen.findByText(/platform down/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('offers Redrive on dead and pending legs, never on a delivered one', async () => {
    api.listCascadeLegs.mockResolvedValue(page([
      leg(),
      leg({ id: 'leg-stuck', subjectId: 'org-stuck', status: 'pending', attempts: 3 }),
      leg({ id: 'leg-done', subjectId: 'org-done', status: 'done' }),
    ]));
    render(<CascadePage />);
    expect(within(await rowOf('org-gone')).getByRole('button', { name: 'Redrive' })).toBeInTheDocument();
    expect(within(await rowOf('org-stuck')).getByRole('button', { name: 'Redrive' })).toBeInTheDocument();
    expect(within(await rowOf('org-done')).queryByRole('button', { name: 'Redrive' })).toBeNull();
  });

  it('Redrive confirms in a step-up, then POSTs with attempts reset and the reason, and re-reads', async () => {
    render(<CascadePage />);
    fireEvent.click(within(await rowOf('org-gone')).getByRole('button', { name: 'Redrive' }));
    const modal = await screen.findByTestId('stepup-modal');
    expect(within(modal).getByText(/redrive the pipeline leg/i)).toBeInTheDocument();
    expect((within(modal).getByLabelText(/reset attempts/i) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(modal).getByLabelText(/reason/i), { target: { value: ' pipeline fixed ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.redriveCascadeLeg).toHaveBeenCalledWith('leg-dead', { resetAttempts: true, reason: 'pipeline fixed' }, 'tok'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Cascade leg to pipeline queued for redelivery'));
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenCalledTimes(2));
  });

  it('Redrive can keep the attempt count (one probe delivery)', async () => {
    render(<CascadePage />);
    fireEvent.click(within(await rowOf('org-gone')).getByRole('button', { name: 'Redrive' }));
    const modal = await screen.findByTestId('stepup-modal');
    fireEvent.click(within(modal).getByLabelText(/reset attempts/i));
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm step-up' }));
    await waitFor(() => expect(api.redriveCascadeLeg).toHaveBeenCalledWith('leg-dead', { resetAttempts: false }, 'tok'));
  });

  it.each([
    [409, 'This cascade leg was already delivered — there is nothing to redrive'],
    [404, 'Cascade leg not found'],
  ])('a %s refusal is shown, and the list re-read', async (status, message) => {
    api.redriveCascadeLeg.mockRejectedValue(new ApiError(message, status));
    render(<CascadePage />);
    fireEvent.click(within(await rowOf('org-gone')).getByRole('button', { name: 'Redrive' }));
    fireEvent.click(within(await screen.findByTestId('stepup-modal')).getByRole('button', { name: 'Confirm step-up' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(pageToast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenCalledTimes(2));
  });

  it('without orgs:manage the Redrive is shown but inert, and nothing is sent', async () => {
    mockAuthGuard({ user: { id: 'op', organizationId: 'system' }, can: (p: string) => p === 'platform:read' });
    render(<CascadePage />);
    const button = within(await rowOf('org-gone')).getByRole('button', { name: 'Redrive' });
    expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByTestId('stepup-modal')).toBeNull();
  });

  it('a page left empty (its legs moved out of the filter) steps back instead of showing "51–50 of 50"', async () => {
    api.listCascadeLegs
      .mockResolvedValueOnce(ok({ legs: [leg()], pagination: { total: 51, limit: 50, offset: 0, hasMore: true } }))
      .mockResolvedValueOnce(ok({ legs: [], pagination: { total: 50, limit: 50, offset: 50, hasMore: false } }));
    render(<CascadePage />);
    await rowOf('org-gone');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.listCascadeLegs).toHaveBeenLastCalledWith({ limit: 50, offset: 0 }, expect.anything()));
    expect(api.listCascadeLegs).toHaveBeenCalledTimes(3);
  });

  it('a denied viewer sees the access-denied page', () => {
    mockAuthGuard({ accessDenied: { kind: 'permission', permission: 'platform:read', pathname: '/dashboard/admin/cascade' } });
    render(<CascadePage />);
    expect(api.listCascadeLegs).not.toHaveBeenCalled();
  });
});
