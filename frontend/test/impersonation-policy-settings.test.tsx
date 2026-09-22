// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Administrator-access (impersonation policy) settings.
 *
 * The properties that matter:
 *   - A policy forced by a PARENT organization is explained, not hidden — an
 *     admin who picks "Open" must be able to see why it doesn't apply.
 *   - Saving requires re-entering the password (loosening widens data access).
 *   - The org's OWN setting is what's edited, not the effective one.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImpersonationPolicySettings } from '../src/components/settings/ImpersonationPolicySettings';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

// StepUpModal stand-in: confirming yields a token, so the save path is testable.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, onConfirmed }: { action: string; onConfirmed: (t: string) => void }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
    </div>
  ),
}));

const getImpersonationPolicy = jest.fn<AnyFn>();
const updateImpersonationPolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getImpersonationPolicy: (...a: unknown[]) => getImpersonationPolicy(...a),
    updateImpersonationPolicy: (...a: unknown[]) => updateImpersonationPolicy(...a),
  },
}));

const policy = (over: Record<string, unknown> = {}) => ({
  policy: 'consent', allowSelfApproval: true,
  own: { policy: 'consent', allowSelfApproval: true },
  resolved: true,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getImpersonationPolicy.mockResolvedValue({ success: true, data: policy() });
  updateImpersonationPolicy.mockResolvedValue({ success: true, data: policy({ policy: 'open', own: { policy: 'open', allowSelfApproval: true } }) });
});

describe('ImpersonationPolicySettings', () => {
  it('shows the org\'s current setting', async () => {
    render(<ImpersonationPolicySettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByRole('radio', { name: /ask first/i })).toBeChecked();
  });

  it('explains when a PARENT organization forces a stricter policy', async () => {
    getImpersonationPolicy.mockResolvedValue({
      success: true,
      data: policy({ policy: 'consent', own: { policy: 'open', allowSelfApproval: true }, inheritedFrom: 'parent-org' }),
    });
    render(<ImpersonationPolicySettings orgId="team-1" readOnly={false} />);

    expect(await screen.findByText(/parent organization requires a stricter policy/i)).toBeInTheDocument();
    // The org's OWN choice is what's shown for editing.
    expect(screen.getByRole('radio', { name: /^open/i })).toBeChecked();
  });

  it('names the parent organization when the server resolves it', async () => {
    getImpersonationPolicy.mockResolvedValue({
      success: true,
      data: policy({ own: { policy: 'open', allowSelfApproval: true }, inheritedFrom: 'parent-org', inheritedFromName: 'Acme Corp' }),
    });
    render(<ImpersonationPolicySettings orgId="team-1" readOnly={false} />);
    const callout = (await screen.findByText('Acme Corp')).closest('div')!;
    expect(callout).toHaveTextContent(/the parent organization acme corp requires a stricter policy/i);
  });

  it('warns when the parent\'s setting couldn\'t be read', async () => {
    getImpersonationPolicy.mockResolvedValue({ success: true, data: policy({ resolved: false }) });
    render(<ImpersonationPolicySettings orgId="team-1" readOnly={false} />);
    expect(await screen.findByText(/couldn.t be read/i)).toBeInTheDocument();
  });

  it('keeps Save disabled until something changes', async () => {
    render(<ImpersonationPolicySettings orgId="org-1" readOnly={false} />);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /^open/i }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saving asks for the password first, then sends the step-up token', async () => {
    render(<ImpersonationPolicySettings orgId="org-1" readOnly={false} />);
    fireEvent.click(await screen.findByRole('radio', { name: /^open/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateImpersonationPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));

    await waitFor(() => expect(updateImpersonationPolicy).toHaveBeenCalledWith(
      'org-1', { impersonationPolicy: 'open', allowSelfApproval: true }, 'step-up-token',
    ));
  });

  it('shows the server\'s refusal (e.g. "Emergencies only" with one administrator)', async () => {
    updateImpersonationPolicy.mockRejectedValue(new Error('"denied" requires at least 2 sysadmin accounts'));
    render(<ImpersonationPolicySettings orgId="org-1" readOnly={false} />);
    fireEvent.click(await screen.findByRole('radio', { name: /emergencies only/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));

    expect(await screen.findByText(/requires at least 2 sysadmin accounts/i)).toBeInTheDocument();
  });

  it('is fully disabled during read-only impersonation', async () => {
    render(<ImpersonationPolicySettings orgId="org-1" readOnly />);
    expect(await screen.findByRole('radio', { name: /^open/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
