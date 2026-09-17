// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RuleList: a server-forwarded filter change refetches, and the loading state
 * must render INLINE — the filter bar (including the control the user just
 * changed) and the RecentlyDeletedPanel must stay mounted rather than being
 * swapped out for a full-component spinner.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RuleList from '../src/components/compliance/RuleList';
import type { ComplianceRule } from '../src/types/compliance';

let panelMounts = 0;
jest.mock('@/components/RecentlyDeletedPanel', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    __esModule: true,
    RecentlyDeletedPanel: () => {
      useEffect(() => { panelMounts += 1; }, []);
      return <div data-testid="recently-deleted" />;
    },
  };
});

const getComplianceRules = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getComplianceRules: (...a: unknown[]) => getComplianceRules(...a),
    createComplianceRule: jest.fn(),
    updateComplianceRule: jest.fn(),
    deleteComplianceRule: jest.fn(),
  },
}));

const rule = {
  id: 'r1', orgId: 'o1', name: 'No latest tags', priority: 0, target: 'plugin', severity: 'warning',
  tags: [], scope: 'org', suppressNotification: false, isActive: true,
  createdAt: '2026-01-01', updatedAt: '2026-01-01', createdBy: 'u1',
} as unknown as ComplianceRule;

const listOk = { success: true, data: { rules: [rule], pagination: { total: 1, limit: 20, offset: 0 } } };

beforeEach(() => {
  jest.clearAllMocks();
  panelMounts = 0;
});

it('keeps the filter bar and recently-deleted panel mounted while a filter change reloads', async () => {
  getComplianceRules.mockResolvedValueOnce(listOk);
  render(<RuleList onEdit={jest.fn()} />);
  expect(await screen.findByText('No latest tags')).toBeInTheDocument();
  expect(panelMounts).toBe(1);

  const targetSelect = screen.getByRole('combobox', { name: 'Filter rules by target' });
  let resolveReload!: (v: unknown) => void;
  getComplianceRules.mockImplementationOnce(() => new Promise((r) => { resolveReload = r; }));
  fireEvent.change(targetSelect, { target: { value: 'pipeline' } });

  // Mid-reload: spinner is inline, and the same filter element is still in the DOM.
  expect(await screen.findByRole('status', { name: 'Loading rules' })).toBeInTheDocument();
  expect(targetSelect).toBeInTheDocument();
  expect(targetSelect).toHaveValue('pipeline');
  expect(screen.getByTestId('recently-deleted')).toBeInTheDocument();
  expect(getComplianceRules).toHaveBeenLastCalledWith(expect.objectContaining({ target: 'pipeline' }));

  await act(async () => { resolveReload(listOk); });
  await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading rules' })).toBeNull());
  expect(screen.getByText('No latest tags')).toBeInTheDocument();
  // The panel never remounted (it would re-fetch its deleted list if it did).
  expect(panelMounts).toBe(1);
});
