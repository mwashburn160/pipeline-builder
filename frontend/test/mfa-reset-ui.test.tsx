// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard half of MFA recovery without database access:
 *   - "Reset MFA…" files a REQUEST (with a reason, behind step-up) — nothing is
 *     reset until a second admin approves;
 *   - the pending panel never offers "Approve" to the requester or to the person
 *     being reset (the server refuses both), and approval asks for a STRONG
 *     factor;
 *   - a sysadmin's direct reset needs a reason and a strong-factor step-up;
 *   - a single-factor refusal is left to the shell's MFA dialog, not repeated.
 */

import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';

const requestMfaReset = jest.fn();
const listMfaResets = jest.fn();
const approveMfaReset = jest.fn();
const denyMfaReset = jest.fn();
const resetUserMfa = jest.fn();
const toastSuccess = jest.fn();
const toastError = jest.fn();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    requestMfaReset: (...a: unknown[]) => requestMfaReset(...a),
    listMfaResets: (...a: unknown[]) => listMfaResets(...a),
    approveMfaReset: (...a: unknown[]) => approveMfaReset(...a),
    denyMfaReset: (...a: unknown[]) => denyMfaReset(...a),
    resetUserMfa: (...a: unknown[]) => resetUserMfa(...a),
  },
}));
const toast = { success: toastSuccess, error: toastError, warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/Toast', () => ({ __esModule: true, useToast: () => toast }));

let lastStrong: boolean | undefined;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, requireStrongFactor }: { onConfirmed: (t: string) => void; requireStrongFactor?: boolean }) => {
    lastStrong = requireStrongFactor;
    return <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm</button>;
  },
}));

import { MfaRequiredError } from '@/lib/api/errors';
import { MfaResetPanel } from '../src/components/members/MfaResetPanel';
import { RequestMfaResetModal } from '../src/components/members/RequestMfaResetModal';
import { DirectMfaResetModal } from '../src/components/users/DirectMfaResetModal';
import type { MfaResetRequest, OrganizationMember } from '@/types';

const member = { id: 'm1', username: 'mia', email: 'mia@example.com' } as OrganizationMember;
const request = (over: Partial<MfaResetRequest> = {}): MfaResetRequest => ({
  id: 'r1', organizationId: 'org-1', targetUserId: 'm1', targetEmail: 'mia@example.com',
  requestedBy: 'a1', requestedByEmail: 'a1@example.com', reason: 'Lost phone and laptop', status: 'pending',
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  lastStrong = undefined;
});

describe('RequestMfaResetModal', () => {
  it('needs a real reason, then files the request behind step-up', async () => {
    requestMfaReset.mockResolvedValue({ success: true, message: 'Reset requested', data: { request: request() } });
    const onRequested = jest.fn();
    const onClose = jest.fn();
    render(<RequestMfaResetModal orgId="org-1" member={member} onClose={onClose} onRequested={onRequested} />);

    const submit = screen.getByRole('button', { name: /request reset/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason for the reset/i), { target: { value: 'Phone stolen; confirmed on a call' } });
    fireEvent.click(submit);
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(requestMfaReset).toHaveBeenCalledWith('org-1', { userId: 'm1', reason: 'Phone stolen; confirmed on a call' }, 'step-up-token');
    expect(onRequested).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('says plainly that a second admin must approve', () => {
    render(<RequestMfaResetModal orgId="org-1" member={member} onClose={jest.fn()} onRequested={jest.fn()} />);
    expect(screen.getByText(/nothing happens until/i)).toHaveTextContent(/another/i);
  });

  it('leaves a single-factor refusal to the shell\'s MFA dialog', async () => {
    requestMfaReset.mockRejectedValue(new MfaRequiredError('needs two factors', 'MFA_REQUIRED'));
    const onClose = jest.fn();
    render(<RequestMfaResetModal orgId="org-1" member={member} onClose={onClose} onRequested={jest.fn()} />);
    fireEvent.change(screen.getByLabelText(/reason for the reset/i), { target: { value: 'Phone stolen; confirmed on a call' } });
    fireEvent.click(screen.getByRole('button', { name: /request reset/i }));
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    expect(onClose).toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('MfaResetPanel', () => {
  it('renders nothing when there is nothing to show', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [] } });
    const { container } = render(<MfaResetPanel orgId="org-1" currentUserId="a2" readOnly={false} />);
    await waitFor(() => expect(listMfaResets).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(container).toBeEmptyDOMElement();
  });

  it('lets ANOTHER admin approve, with a strong-factor step-up', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [request()] } });
    approveMfaReset.mockResolvedValue({ success: true, message: 'Reset', data: { request: request({ status: 'approved' }) } });
    render(<MfaResetPanel orgId="org-1" currentUserId="a2" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    expect(lastStrong).toBe(true);
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    expect(approveMfaReset).toHaveBeenCalledWith('org-1', 'r1', {}, 'step-up-token');
  });

  it('offers the requester only "Withdraw", never "Approve"', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [request({ requestedBy: 'a1' })] } });
    render(<MfaResetPanel orgId="org-1" currentUserId="a1" readOnly={false} />);
    expect(await screen.findByRole('button', { name: /withdraw/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/a different admin has to approve it/i)).toBeInTheDocument();
  });

  it('offers the person being reset neither button', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [request({ targetUserId: 'me' })] } });
    render(<MfaResetPanel orgId="org-1" currentUserId="me" readOnly={false} />);
    await screen.findByText(/this request is about you/i);
    expect(screen.queryByRole('button', { name: /approve|deny|withdraw/i })).not.toBeInTheDocument();
  });

  it('keeps the deny dialog up, in its in-flight state, until the call settles', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [request()] } });
    let release: (v: unknown) => void = () => undefined;
    denyMfaReset.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<MfaResetPanel orgId="org-1" currentUserId="a2" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /^deny$/i }));
    // Two "Deny" buttons once the dialog is up: the row's and the dialog's.
    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /^deny$/i })); });
    // The dialog used to close on the click, so Deny looked like it did nothing
    // while the request was still on the wire.
    expect(screen.getByText('Working…')).toBeInTheDocument();
    await act(async () => { release({ success: true, message: 'Request closed' }); });
    await waitFor(() => expect(screen.queryByText('Working…')).not.toBeInTheDocument());
  });

  it('announces a decision through a live region that was already on the page', async () => {
    listMfaResets.mockResolvedValue({ success: true, data: { requests: [request()] } });
    approveMfaReset.mockResolvedValue({ success: true, message: 'Two-factor reset for mia@example.com', data: {} });
    const { container } = render(<MfaResetPanel orgId="org-1" currentUserId="a2" readOnly={false} />);

    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    // Present and empty BEFORE the decision — a region added together with its
    // text is not announced.
    const live = container.querySelector('[role="status"]')!;
    expect(live).toHaveTextContent('');
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });
    await waitFor(() => expect(live).toHaveTextContent('Two-factor reset for mia@example.com'));
  });

  it('shows recent decisions', async () => {
    listMfaResets.mockResolvedValue({
      success: true,
      data: { requests: [request({ status: 'approved', decidedByEmail: 'a2@example.com', decidedAt: new Date().toISOString(), result: { passkeysRemoved: 1, totpRemoved: true, recoveryCodesRemoved: true, graceUntil: new Date().toISOString() } })] },
    });
    render(<MfaResetPanel orgId="org-1" currentUserId="a3" readOnly={false} />);
    expect(await screen.findByText(/recently decided/i)).toBeInTheDocument();
    expect(screen.getByText('approved')).toBeInTheDocument();
    expect(screen.getByText(/by a2@example.com/)).toBeInTheDocument();
  });
});

describe('DirectMfaResetModal (sysadmin)', () => {
  it('needs a reason and a strong-factor step-up', async () => {
    resetUserMfa.mockResolvedValue({ success: true, message: 'Reset', data: {} });
    const onDone = jest.fn();
    render(<DirectMfaResetModal target={{ id: 'u9', email: 'solo@example.com' }} onClose={jest.fn()} onDone={onDone} />);

    const submit = screen.getByRole('button', { name: /reset two-factor/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason for the reset/i), { target: { value: 'Sole admin; verified via ticket 1234' } });
    fireEvent.click(submit);
    expect(lastStrong).toBe(true);
    await act(async () => { fireEvent.click(screen.getByTestId('stepup-modal')); });

    expect(resetUserMfa).toHaveBeenCalledWith('u9', { reason: 'Sole admin; verified via ticket 1234' }, 'step-up-token');
    expect(onDone).toHaveBeenCalled();
  });

  it('steers toward the two-person reset', () => {
    render(<DirectMfaResetModal target={{ id: 'u9', email: 'solo@example.com' }} onClose={jest.fn()} onDone={jest.fn()} />);
    expect(screen.getByText(/prefer the two-person reset/i)).toBeInTheDocument();
  });
});
