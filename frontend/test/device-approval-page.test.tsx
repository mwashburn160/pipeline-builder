// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Device approval page (`/auth/device`) — the browser half of `pipeline-manager
 * auth login`.
 *
 * What matters here: the person is shown WHICH device they are approving before
 * they can approve it, approving goes through the step-up modal (the backend
 * refuses without the token), denying does not, and an expired code says so
 * instead of "check what you typed".
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeviceApprovalPage from '../pages/auth/device';
import { ApiError } from '../src/lib/api/errors';

const push = jest.fn();
let query: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query, asPath: '/auth/device?user_code=BCDF-GHJK', push }),
}));

let auth = { isAuthenticated: true, isInitialized: true, isLoading: false };
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => auth,
}));

// StepUpModal → confirms immediately with a fixed token, so the gated call runs.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm step-up</button>
  ),
}));

const getDeviceAuthorization = jest.fn();
const approveDeviceAuthorization = jest.fn();
const denyDeviceAuthorization = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getDeviceAuthorization: (...a: unknown[]) => getDeviceAuthorization(...a),
    approveDeviceAuthorization: (...a: unknown[]) => approveDeviceAuthorization(...a),
    denyDeviceAuthorization: (...a: unknown[]) => denyDeviceAuthorization(...a),
  },
}));

const REQUEST = {
  userCode: 'BCDF-GHJK',
  client: 'pipeline-manager CLI on macOS',
  ip: '203.0.113.7',
  requestedAt: '2026-09-17T10:00:00Z',
  expiresAt: '2026-09-17T10:10:00Z',
  stepUpRequested: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  query = { user_code: 'BCDF-GHJK' };
  auth = { isAuthenticated: true, isInitialized: true, isLoading: false };
  getDeviceAuthorization.mockResolvedValue({ success: true, data: { request: REQUEST } });
  approveDeviceAuthorization.mockResolvedValue({ success: true, data: { approved: true, request: REQUEST } });
  denyDeviceAuthorization.mockResolvedValue({ success: true, data: { denied: true } });
  window.sessionStorage.clear();
});

describe('device approval page', () => {
  it('looks the code from the link up and names the device being approved', async () => {
    render(<DeviceApprovalPage />);

    expect(await screen.findByText('Approve this sign-in?')).toBeInTheDocument();
    expect(getDeviceAuthorization).toHaveBeenCalledWith('BCDF-GHJK');
    expect(screen.getByText('pipeline-manager CLI on macOS')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('BCDF-GHJK')).toBeInTheDocument();
  });

  it('approves only through step-up, forwarding the token', async () => {
    render(<DeviceApprovalPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    // The modal is what produces the token; nothing is sent before it confirms.
    expect(approveDeviceAuthorization).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('stepup-modal'));

    await waitFor(() => expect(approveDeviceAuthorization).toHaveBeenCalledWith('BCDF-GHJK', 'step-up-token'));
    expect(await screen.findByText('Device approved')).toBeInTheDocument();
  });

  it('denies without a step-up', async () => {
    render(<DeviceApprovalPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));

    await waitFor(() => expect(denyDeviceAuthorization).toHaveBeenCalledWith('BCDF-GHJK'));
    expect(await screen.findByText('Request denied')).toBeInTheDocument();
    expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument();
  });

  it('tells the user to start again when the code has expired', async () => {
    getDeviceAuthorization.mockRejectedValue(new ApiError('gone', 410));
    render(<DeviceApprovalPage />);

    expect(await screen.findByText(/has expired/)).toBeInTheDocument();
    expect(screen.queryByText('Approve this sign-in?')).not.toBeInTheDocument();
  });

  it('asks for the code when the link carried none', async () => {
    query = {};
    render(<DeviceApprovalPage />);

    expect(await screen.findByText('Enter the code from your device')).toBeInTheDocument();
    expect(getDeviceAuthorization).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'bcdf-ghjk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    // Upper-cased as typed; the backend normalizes the separator either way.
    await waitFor(() => expect(getDeviceAuthorization).toHaveBeenCalledWith('BCDF-GHJK'));
  });

  it('remembers where to come back to when the visitor is signed out', async () => {
    auth = { isAuthenticated: false, isInitialized: true, isLoading: false };
    render(<DeviceApprovalPage />);

    expect(await screen.findByText('Sign in to approve this device')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('pb.postSignIn')).toBe('/auth/device?user_code=BCDF-GHJK');
    expect(getDeviceAuthorization).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(push).toHaveBeenCalledWith('/');
  });
});
