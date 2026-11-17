// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The add-to-team email field: labelled, and Enter does not re-submit while the add is in flight. */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddToTeamModal } from '@/components/members/AddToTeamModal';
import type { FormState } from '@/hooks/useFormState';

const form = (loading: boolean, error: string | null = null) => ({ loading, error, success: null } as unknown as FormState);

describe('AddToTeamModal', () => {
  it('submits on Enter when idle', () => {
    const onSubmit = jest.fn<AnyFn>();
    render(<AddToTeamModal target={{ orgId: 't1', orgName: 'Platform' }} email="bee@acme.test" onEmailChange={jest.fn()} form={form(false)} onSubmit={onSubmit} onClose={jest.fn()} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Email address' }), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not submit again while the add is in flight', () => {
    const onSubmit = jest.fn<AnyFn>();
    render(<AddToTeamModal target={{ orgId: 't1', orgName: 'Platform' }} email="bee@acme.test" onEmailChange={jest.fn()} form={form(true)} onSubmit={onSubmit} onClose={jest.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Email address' });
    expect(box).toBeDisabled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe('a person outside the account (MEMBER_INVITATION_REQUIRED)', () => {
    const refused = form(false, 'That person is not in your organization yet. Send them an invitation — they join when they accept.');

    it('offers an invitation to the organization for the refused address', () => {
      render(<AddToTeamModal target={{ orgId: 't1', orgName: 'Platform' }} email="out@other.io" onEmailChange={jest.fn()} form={refused} onSubmit={jest.fn()} onClose={jest.fn()} canInvite inviteEmail="out@other.io" />);
      expect(screen.getByText(/not in your organization yet/i)).toBeInTheDocument();
      const link = screen.getByRole('link', { name: /invite out@other.io to the organization/i });
      expect(link).toHaveAttribute('href', '/dashboard/invitations?email=out%40other.io');
    });

    it('names who can invite (no link) without invitation access', () => {
      render(<AddToTeamModal target={{ orgId: 't1', orgName: 'Platform' }} email="out@other.io" onEmailChange={jest.fn()} form={refused} onSubmit={jest.fn()} onClose={jest.fn()} inviteEmail="out@other.io" />);
      expect(screen.getByText(/ask an admin with invitation access/i)).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('drops the offer once the address is edited', () => {
      render(<AddToTeamModal target={{ orgId: 't1', orgName: 'Platform' }} email="someone@else.io" onEmailChange={jest.fn()} form={refused} onSubmit={jest.fn()} onClose={jest.fn()} canInvite inviteEmail="out@other.io" />);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });
});
