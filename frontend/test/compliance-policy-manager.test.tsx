// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PolicyManager error recovery: a failed mutation must NOT replace the whole
 * component with a dead-end error. The error renders inline and dismissible,
 * the policy list and the RecentlyDeletedPanel stay mounted, and the next
 * action works. A failed load offers Retry.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import PolicyManager from '../src/components/compliance/PolicyManager';
import type { CompliancePolicy } from '../src/types/compliance';

jest.mock('@/components/RecentlyDeletedPanel', () => ({
  __esModule: true,
  RecentlyDeletedPanel: () => <div data-testid="recently-deleted" />,
}));

const getCompliancePolicies = jest.fn<AnyFn>();
const createCompliancePolicy = jest.fn<AnyFn>();
const updateCompliancePolicy = jest.fn<AnyFn>();
const deleteCompliancePolicy = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getCompliancePolicies: (...a: unknown[]) => getCompliancePolicies(...a),
    createCompliancePolicy: (...a: unknown[]) => createCompliancePolicy(...a),
    updateCompliancePolicy: (...a: unknown[]) => updateCompliancePolicy(...a),
    deleteCompliancePolicy: (...a: unknown[]) => deleteCompliancePolicy(...a),
  },
}));

function policy(over: Partial<CompliancePolicy>): CompliancePolicy {
  return {
    id: 'p1', orgId: 'o1', name: 'Baseline', version: '1.0.0', isActive: true,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'u1',
    ...over,
  } as CompliancePolicy;
}

const listOk = (policies: CompliancePolicy[]) => ({
  success: true,
  data: { policies, pagination: { total: policies.length, limit: 20, offset: 0 } },
});

beforeEach(() => {
  jest.clearAllMocks();
  getCompliancePolicies.mockResolvedValue(listOk([policy({})]));
});

it('shows a failed toggle inline + dismissible while the list stays rendered, and the next action works', async () => {
  render(<PolicyManager />);
  expect(await screen.findByText('Baseline')).toBeInTheDocument();

  updateCompliancePolicy.mockRejectedValueOnce(new Error('toggle exploded'));
  fireEvent.click(screen.getByRole('button', { name: 'Deactivate policy' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('toggle exploded');
  // The list, header action and restore panel are still there.
  expect(screen.getByText('Baseline')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /new policy/i })).toBeInTheDocument();
  expect(screen.getByTestId('recently-deleted')).toBeInTheDocument();
  // A mutation failure is not a load failure — no Retry.
  expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull();

  fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

  // Next action succeeds and updates the row.
  updateCompliancePolicy.mockResolvedValueOnce({ success: true, data: { policy: policy({ isActive: false }) } });
  fireEvent.click(screen.getByRole('button', { name: 'Deactivate policy' }));
  expect(await screen.findByRole('button', { name: 'Activate policy' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('keeps the list after a failed delete and shows the error inline', async () => {
  render(<PolicyManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete policy' }));

  deleteCompliancePolicy.mockResolvedValueOnce({ success: false });
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await screen.findByRole('alert')).toHaveTextContent(/failed to delete/i);
  expect(screen.getByText('Baseline')).toBeInTheDocument();
});

it('offers Retry for a failed load, which recovers the list', async () => {
  getCompliancePolicies.mockRejectedValueOnce(new Error('load exploded'));
  render(<PolicyManager />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('load exploded');
  expect(screen.getByRole('button', { name: /new policy/i })).toBeInTheDocument();

  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Baseline')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});
