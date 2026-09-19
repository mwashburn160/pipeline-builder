// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sessions and devices panel (Security → Sessions): the two lists (signed-in
 * devices / stored machine credentials), the current-session marker, and the
 * single-dialog revoke. Revoking is step-up gated on the backend, so ONE dialog
 * states the consequence and takes the factor, and its token must reach
 * `api.revokeSession`. "Sign out everywhere" lives here too — it used to be on
 * a second, contradictory sessions view on the API Tokens page.
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

// StepUpModal → immediately "confirms" with a fixed token so the gated call
// runs. Its `title`/`details` are recorded: the point of the single dialog is
// that the consequence is stated IN it, not in a dialog before it.
let lastStepUp: { title?: string; detailsText: string } | null = null;
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ title, details, onConfirmed }: { title?: string; details?: React.ReactNode; onConfirmed: (t: string) => void }) => {
    lastStepUp = { title, detailsText: '' };
    return (
      <div data-testid="stepup-dialog">
        <span>{title}</span>
        <div data-testid="stepup-details">{details}</div>
        <button data-testid="stepup-modal" onClick={() => onConfirmed('step-up-token')}>confirm step-up</button>
      </div>
    );
  },
}));

const listSessions = jest.fn();
const revokeSession = jest.fn();
const revokeAllTokens = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listSessions: (...a: unknown[]) => listSessions(...a),
    revokeSession: (...a: unknown[]) => revokeSession(...a),
    revokeAllTokens: (...a: unknown[]) => revokeAllTokens(...a),
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
    lastStepUp = null;
    listSessions.mockResolvedValue({ success: true, data: { sessions: [device], machineSessions: [machine] } });
    revokeSession.mockResolvedValue({ success: true, data: { revoked: true } });
    revokeAllTokens.mockResolvedValue({ success: true, data: { revoked: true } });
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
    // ("Sign out everywhere" is a different control — it ends everything.)
    expect(screen.queryByRole('button', { name: /^Sign out$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop renewal/ })).toBeInTheDocument();
  });

  it('revokes from ONE dialog that both asks and steps up', async () => {
    render(<SessionsSection readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /Stop renewal/ }));

    // Exactly one dialog — it carries the question AND the consequence, rather
    // than a confirm modal in front of a step-up modal.
    const dialog = await screen.findByTestId('stepup-dialog');
    expect(lastStepUp?.title).toMatch(/stop renewing this credential\?/i);
    expect(within(dialog).getByTestId('stepup-details')).toHaveTextContent(/stops renewing/i);
    expect(revokeSession).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('stepup-modal'));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith('sid-machine', 'step-up-token'));
    // The list is reloaded so the revoked credential disappears.
    await waitFor(() => expect(listSessions.mock.calls.length).toBeGreaterThan(1));
  });

  it('signs out everywhere from the same one-dialog rule', async () => {
    render(<SessionsSection readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: /sign out everywhere/i }));

    expect(lastStepUp?.title).toMatch(/sign out everywhere\?/i);
    expect(revokeAllTokens).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('stepup-modal'));

    await waitFor(() => expect(revokeAllTokens).toHaveBeenCalledWith('step-up-token'));
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
