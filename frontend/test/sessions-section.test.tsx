// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sessions and devices panel (Settings → Security): the two lists (signed-in
 * devices / stored machine credentials), the current-session marker, and the
 * confirm → step-up → revoke click-through. Revoking is step-up gated on the
 * backend, so the token from StepUpModal must reach `api.revokeSession`.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SessionsSection } from '../src/components/settings/SessionsSection';

// One STABLE toast object: `useLoadable` treats it as a `reload` dependency, so a
// fresh object per render would refetch in a loop.
const toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => toast,
}));

// StepUpModal → immediately "confirms" with a fixed token so the gated call runs.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm step-up</button>
  ),
}));

const listSessions = jest.fn();
const revokeSession = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listSessions: (...a: unknown[]) => listSessions(...a),
    revokeSession: (...a: unknown[]) => revokeSession(...a),
  },
}));

const device = {
  id: 'sid-current',
  kind: 'interactive' as const,
  createdAt: '2026-09-01T10:00:00Z',
  lastUsedAt: '2026-09-02T10:00:00Z',
  signedInAt: '2026-09-01T10:00:00Z',
  userAgent: 'Chrome on macOS',
  lastIp: '203.0.113.7',
  scope: null,
  amr: ['pwd'],
  current: true,
};
const machine = {
  id: 'sid-machine',
  kind: 'machine' as const,
  createdAt: '2026-08-01T10:00:00Z',
  lastUsedAt: '2026-09-02T09:00:00Z',
  signedInAt: '2026-08-01T10:00:00Z',
  userAgent: 'pipeline-manager CLI on macOS',
  lastIp: '198.51.100.9',
  scope: 'reporting:ingest',
  amr: ['pwd'],
  current: false,
};

describe('SessionsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listSessions.mockResolvedValue({ success: true, data: { sessions: [device], machineSessions: [machine] } });
    revokeSession.mockResolvedValue({ success: true, data: { revoked: true } });
  });

  it('lists devices and machine credentials with their details', async () => {
    render(<SessionsSection readOnly={false} />);
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('Password')).toBeInTheDocument();
    // The machine credential is listed separately, labelled by scope.
    expect(screen.getByText('reporting:ingest')).toBeInTheDocument();
    expect(screen.getByText('198.51.100.9')).toBeInTheDocument();
  });

  it('marks the current session and offers no revoke control for it', async () => {
    render(<SessionsSection readOnly={false} />);
    expect(await screen.findByText('This device')).toBeInTheDocument();
    // Only the machine credential (not the current device) can be revoked.
    expect(screen.queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop renewal/ })).toBeInTheDocument();
  });

  it('confirms, then step-ups, then revokes — forwarding the step-up token', async () => {
    render(<SessionsSection readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Stop renewal/ }));
    // Confirm dialog first (irreversible), then the step-up gate. The dialog's
    // confirm button is the one inside the dialog, not the row action.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Stop renewal$/ }));
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('sid-machine', 'step-up-token'));
    // The list is reloaded so the revoked credential disappears.
    await waitFor(() => expect(listSessions.mock.calls.length).toBeGreaterThan(1));
  });

  it('disables revoking under read-only impersonation', async () => {
    render(<SessionsSection readOnly />);
    const button = await screen.findByRole('button', { name: /Stop renewal/ });
    expect(button).toBeDisabled();
  });

  it('surfaces a load failure instead of an empty list', async () => {
    listSessions.mockResolvedValue({ success: false });
    render(<SessionsSection readOnly={false} />);
    expect(await screen.findByText(/Failed to load sessions/)).toBeInTheDocument();
    expect(screen.queryByText('Chrome on macOS')).not.toBeInTheDocument();
  });
});
