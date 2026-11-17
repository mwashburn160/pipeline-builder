// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The add-to-team email field: labelled, and Enter does not re-submit while the add is in flight. */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddToTeamModal } from '@/components/members/AddToTeamModal';
import type { FormState } from '@/hooks/useFormState';

const form = (loading: boolean) => ({ loading, error: null, success: null } as unknown as FormState);

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
});
