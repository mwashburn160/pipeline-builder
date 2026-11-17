// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optimistic concurrency on the compliance editors: a rule or policy save
 * carries the `updatedAt` it was opened on as `expectedUpdatedAt`, and the
 * server's 412 PRECONDITION_FAILED (someone else saved in between) is shown as
 * "changed by someone else — Reload", never as a silent overwrite or a raw
 * error. Reload re-reads the record and resets the form to it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RuleEditor from '@/components/compliance/RuleEditor';
import RuleList from '@/components/compliance/RuleList';
import PolicyManager from '@/components/compliance/PolicyManager';
import { ApiError } from '@/lib/api/errors';
import { CONCURRENCY_CONFLICT_MESSAGE } from '@/lib/api/concurrency';
import type { ComplianceRule, CompliancePolicy } from '@/types/compliance';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));

const api = {
  getComplianceRule: jest.fn<AnyFn>(),
  getComplianceRules: jest.fn<AnyFn>(),
  createComplianceRule: jest.fn<AnyFn>(),
  updateComplianceRule: jest.fn<AnyFn>(),
  deleteComplianceRule: jest.fn<AnyFn>(),
  getCompliancePolicies: jest.fn<AnyFn>(),
  createCompliancePolicy: jest.fn<AnyFn>(),
  updateCompliancePolicy: jest.fn<AnyFn>(),
  deleteCompliancePolicy: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k](...a) }),
}));

const conflict = () => new ApiError('The record was modified by someone else.', 412, 'PRECONDITION_FAILED', {
  expectedUpdatedAt: '2026-01-01T00:00:00.000Z', currentUpdatedAt: '2026-01-02T00:00:00.000Z',
});

const RULE = {
  id: 'r1', orgId: 'o1', name: 'No latest tags', priority: 0, target: 'plugin', severity: 'warning',
  tags: [], scope: 'org', suppressNotification: false, isActive: true, field: 'name', operator: 'eq', value: 'x',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1',
} as unknown as ComplianceRule;

const POLICY = {
  id: 'p1', orgId: 'o1', name: 'Baseline', version: '1.0.0', isActive: true, description: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1',
} as unknown as CompliancePolicy;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RuleEditor', () => {
  it('sends expectedUpdatedAt; a 412 offers Reload, which resets the form to the latest rule', async () => {
    api.updateComplianceRule.mockRejectedValueOnce(conflict());
    const onSave = jest.fn<AnyFn>();
    render(<RuleEditor rule={RULE} onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'My stale name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Rule' }));
    await waitFor(() => expect(api.updateComplianceRule).toHaveBeenCalledTimes(1));
    expect(api.updateComplianceRule.mock.calls[0]).toEqual(['r1', expect.objectContaining({ expectedUpdatedAt: '2026-01-01T00:00:00.000Z' })]);

    expect(await screen.findByTestId('concurrency-conflict')).toHaveTextContent(CONCURRENCY_CONFLICT_MESSAGE);
    expect(screen.queryByText('The record was modified by someone else.')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();

    const LATEST = { ...RULE, name: 'Their name', updatedAt: '2026-01-02T00:00:00.000Z' };
    api.getComplianceRule.mockResolvedValueOnce({ success: true, data: { rule: LATEST } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Their name'));
    expect(api.getComplianceRule).toHaveBeenCalledWith('r1');
    expect(screen.queryByTestId('concurrency-conflict')).toBeNull();

    api.updateComplianceRule.mockResolvedValueOnce({ success: true, data: { rule: LATEST } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Rule' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(LATEST));
    expect(api.updateComplianceRule.mock.calls[1][1]).toMatchObject({ name: 'Their name', expectedUpdatedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('a failed reload keeps the conflict and says why', async () => {
    api.updateComplianceRule.mockRejectedValueOnce(conflict());
    render(<RuleEditor rule={RULE} onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Update Rule' }));
    await screen.findByTestId('concurrency-conflict');
    api.getComplianceRule.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(screen.getByTestId('concurrency-conflict')).toBeInTheDocument();
  });
});

describe('RuleList toggle', () => {
  it('is conditional on the row shown; a 412 offers Reload, which re-reads the list', async () => {
    api.getComplianceRules.mockResolvedValue({ success: true, data: { rules: [RULE], pagination: { total: 1, limit: 20, offset: 0 } } });
    api.updateComplianceRule.mockRejectedValueOnce(conflict());
    render(<RuleList onEdit={() => {}} />);
    expect(await screen.findByText('No latest tags')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /deactivate/i }));
    await waitFor(() => expect(api.updateComplianceRule).toHaveBeenCalledWith('r1', { isActive: false, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }));
    expect(await screen.findByTestId('concurrency-conflict')).toHaveTextContent(CONCURRENCY_CONFLICT_MESSAGE);

    const reads = api.getComplianceRules.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.getComplianceRules.mock.calls.length).toBe(reads + 1));
    await waitFor(() => expect(screen.queryByTestId('concurrency-conflict')).toBeNull());
  });
});

describe('PolicyManager', () => {
  it('sends expectedUpdatedAt from the opened policy; a 412 offers Reload, which re-seeds the open form', async () => {
    api.getCompliancePolicies.mockResolvedValue({ success: true, data: { policies: [POLICY], pagination: { total: 1, limit: 20, offset: 0 } } });
    api.updateCompliancePolicy.mockRejectedValueOnce(conflict());
    render(<PolicyManager />);
    expect(await screen.findByText('Baseline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit policy' }));
    fireEvent.change(screen.getByPlaceholderText('Policy name'), { target: { value: 'My stale name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Policy' }));
    await waitFor(() => expect(api.updateCompliancePolicy).toHaveBeenCalledWith('p1', expect.objectContaining({
      name: 'My stale name', expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    })));
    expect(await screen.findByTestId('concurrency-conflict')).toHaveTextContent(CONCURRENCY_CONFLICT_MESSAGE);
    // The form stays open with the edit until the person reloads.
    expect(screen.getByPlaceholderText('Policy name')).toHaveValue('My stale name');

    const LATEST = { ...POLICY, name: 'Their name', updatedAt: '2026-01-02T00:00:00.000Z' };
    api.getCompliancePolicies.mockResolvedValue({ success: true, data: { policies: [LATEST], pagination: { total: 1, limit: 20, offset: 0 } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Policy name')).toHaveValue('Their name'));
    expect(screen.queryByTestId('concurrency-conflict')).toBeNull();

    api.updateCompliancePolicy.mockResolvedValueOnce({ success: true, data: { policy: LATEST } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Policy' }));
    await waitFor(() => expect(api.updateCompliancePolicy).toHaveBeenCalledTimes(2));
    expect(api.updateCompliancePolicy.mock.calls[1][1]).toMatchObject({ expectedUpdatedAt: '2026-01-02T00:00:00.000Z' });
  });

  it('the row toggle is conditional on the row shown', async () => {
    api.getCompliancePolicies.mockResolvedValue({ success: true, data: { policies: [POLICY], pagination: { total: 1, limit: 20, offset: 0 } } });
    api.updateCompliancePolicy.mockResolvedValueOnce({ success: true, data: { policy: { ...POLICY, isActive: false } } });
    render(<PolicyManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate policy' }));
    await waitFor(() => expect(api.updateCompliancePolicy).toHaveBeenCalledWith('p1', { isActive: false, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }));
  });
});
