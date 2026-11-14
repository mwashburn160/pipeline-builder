// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Two surfaces no suite loaded before:
 *  - EditUserModal — the sysadmin's cross-org write (org / role reassignment,
 *    sign-in details, impersonation entry points);
 *  - PlanGrid — the plan picker, i.e. what a click on a price buys.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent } from '@testing-library/react';

// The modal's children that do their own reads are out of scope here.
jest.mock('@/components/users/SysadminGrantHistory', () => ({ __esModule: true, SysadminGrantHistory: () => null }));
jest.mock('@/components/admin/FeatureOverridesEditor', () => ({ __esModule: true, FeatureOverridesEditor: () => null }));
jest.mock('@/components/ui/OrgPicker', () => ({
  __esModule: true,
  OrgPicker: ({ id, value, onChange, disabled, valueName }: { id: string; value: string; onChange: (v: string) => void; disabled?: boolean; valueName?: string }) => (
    <select id={id} value={value} disabled={disabled} data-value-name={valueName ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">— No organization —</option>
      <option value="org-a">Alpha</option>
      <option value="org-b">Beta</option>
    </select>
  ),
}));

import { EditUserModal } from '@/components/users/EditUserModal';
import { PlanGrid } from '@/components/billing/PlanGrid';
import type { FormState } from '@/hooks/useFormState';

const form = (over: Partial<FormState> = {}): FormState => ({
  loading: false, error: null, success: null,
  setError: jest.fn(), setSuccess: jest.fn(), reset: jest.fn(),
  run: jest.fn() as unknown as FormState['run'],
  ...over,
} as FormState);

const user = { id: 'u2', username: 'jane', email: 'jane@acme.test', role: 'member' as const, isEmailVerified: true, organizationId: 'org-a', organizationName: 'Alpha' };

function renderModal(over: Record<string, unknown> = {}) {
  const props = {
    editingUser: user, form: form(), currentUserId: 'u1',
    editUsername: 'jane', onEditUsernameChange: jest.fn<AnyFn>(),
    editEmail: 'jane@acme.test', onEditEmailChange: jest.fn<AnyFn>(),
    editOrgId: 'org-a', onEditOrgIdChange: jest.fn<AnyFn>(),
    editRole: 'member' as const, onEditRoleChange: jest.fn<AnyFn>(),
    newPassword: '', onNewPasswordChange: jest.fn<AnyFn>(),
    onImpersonate: jest.fn<AnyFn>(), canImpersonate: true,
    canBreakglass: false, onBreakglass: jest.fn<AnyFn>(),
    onSubmit: jest.fn<AnyFn>(), onClose: jest.fn<AnyFn>(), onFeatureSaved: jest.fn<AnyFn>(),
    ...over,
  };
  render(<EditUserModal {...(props as Parameters<typeof EditUserModal>[0])} />);
  return props;
}

describe('EditUserModal', () => {
  it('renders nothing without a user', () => {
    const { container } = render(<EditUserModal {...({ editingUser: null, form: form() } as unknown as Parameters<typeof EditUserModal>[0])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('routes each field edit to its handler and Save to onSubmit', () => {
    const p = renderModal();
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'jane2' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'j@x.test' } });
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-b' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('Minimum 8 characters'), { target: { value: 'hunter22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(p.onEditUsernameChange).toHaveBeenCalledWith('jane2');
    expect(p.onEditEmailChange).toHaveBeenCalledWith('j@x.test');
    expect(p.onEditOrgIdChange).toHaveBeenCalledWith('org-b');
    expect(p.onEditRoleChange).toHaveBeenCalledWith('admin');
    expect(p.onNewPasswordChange).toHaveBeenCalledWith('hunter22');
    expect(p.onSubmit).toHaveBeenCalled();
  });

  it('keeps the user\'s CURRENT org named even when it is past the picker\'s page', () => {
    renderModal();
    expect(screen.getByLabelText('Organization')).toHaveAttribute('data-value-name', 'Alpha');
  });

  it('locks every field and Save while the fresh read is in flight', () => {
    renderModal({ detailLoading: true });
    for (const label of ['Username', 'Email', 'Organization', 'Role']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the latest details');
  });

  it('shows a failed fresh read without blocking the editor', () => {
    renderModal({ detailError: 'Could not reload the user' });
    expect(screen.getByText('Could not reload the user')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).not.toBeDisabled();
  });

  it('cannot change your own role', () => {
    renderModal({ currentUserId: 'u2' });
    expect(screen.getByLabelText('Role')).toBeDisabled();
    expect(screen.getByText('Cannot change your own role')).toBeInTheDocument();
    // …nor impersonate yourself.
    expect(screen.queryByRole('button', { name: 'View as user' })).not.toBeInTheDocument();
  });

  it('offers View-as only with the permission, emergency access only with the flag, neither on a sysadmin', () => {
    const p = renderModal({ canImpersonate: true, canBreakglass: true });
    fireEvent.click(screen.getByRole('button', { name: 'View as user' }));
    fireEvent.click(screen.getByRole('button', { name: 'Emergency access…' }));
    expect(p.onImpersonate).toHaveBeenCalled();
    expect(p.onBreakglass).toHaveBeenCalled();
  });

  it('never offers impersonation of another sysadmin', () => {
    renderModal({ editingUser: { ...user, isSuperAdmin: true }, canBreakglass: true });
    expect(screen.queryByRole('button', { name: 'View as user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Emergency access…' })).not.toBeInTheDocument();
  });
});

const plan = (id: string, monthly: number, annual: number) => ({
  id, name: id[0].toUpperCase() + id.slice(1), description: `${id} plan`, tier: id, prices: { monthly, annual },
  features: [`${id} feature`], isDefault: false, sortOrder: 0,
});
const plans = [plan('developer', 0, 0), plan('pro', 4900, 49_000), plan('team', 19_900, 199_000)];
const sub = (planId: string) => ({ planId } as never);

describe('PlanGrid', () => {
  it('shows the price for the chosen interval', () => {
    const { rerender } = render(<PlanGrid plans={plans as never} subscription={null} billingInterval="monthly" actionLoading={false} canChangePlan onSubscribe={jest.fn()} />);
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getAllByText('per month')).toHaveLength(2);
    rerender(<PlanGrid plans={plans as never} subscription={null} billingInterval="annual" actionLoading={false} canChangePlan onSubscribe={jest.fn()} />);
    expect(screen.getAllByText('per year')).toHaveLength(2);
  });

  it('subscribes to the clicked plan; "Get started" without a subscription', () => {
    const onSubscribe = jest.fn<AnyFn>();
    render(<PlanGrid plans={plans as never} subscription={null} billingInterval="monthly" actionLoading={false} canChangePlan onSubscribe={onSubscribe} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Get started' })[1]);
    expect(onSubscribe).toHaveBeenCalledWith('pro');
  });

  it('marks the current plan and disables it; others offer a switch', () => {
    const onSubscribe = jest.fn<AnyFn>();
    render(<PlanGrid plans={plans as never} subscription={sub('pro')} billingInterval="monthly" actionLoading={false} canChangePlan onSubscribe={onSubscribe} />);
    const current = screen.getAllByRole('button', { name: 'Current Plan' });
    expect(current).toHaveLength(1);
    expect(current[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Switch to this plan' })).toHaveLength(2);
  });

  it('disables every CTA without permission, while a change is in flight, and for Marketplace billing', () => {
    const { rerender } = render(<PlanGrid plans={plans as never} subscription={sub('pro')} billingInterval="monthly" actionLoading={false} canChangePlan={false} onSubscribe={jest.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    rerender(<PlanGrid plans={plans as never} subscription={sub('pro')} billingInterval="monthly" actionLoading canChangePlan onSubscribe={jest.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
    rerender(<PlanGrid plans={plans as never} subscription={sub('pro')} billingInterval="monthly" actionLoading={false} canChangePlan selfService={false} onSubscribe={jest.fn()} />);
    expect(screen.getAllByRole('button', { name: 'Managed in AWS Marketplace' })).toHaveLength(3);
    for (const b of screen.getAllByRole('button')) expect(b).toBeDisabled();
  });
});
