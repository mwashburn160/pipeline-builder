// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The tenant's support-case controls. A status only staff can set (`resolved`,
 * `awaiting_support`) must still be what the select shows — otherwise it reads
 * "Open" and choosing "Open" (the tenant's reopen) fires no change at all.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const setSupportCaseStatus = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { setSupportCaseStatus: (...a: unknown[]) => setSupportCaseStatus(...a), transferSupportCase: jest.fn() },
}));

import { SupportCasePanel } from '../src/components/message/SupportCasePanel';

const kase = (status: string) => ({
  threadId: 't1', displayNumber: 3, status, severity: 'normal', level: 'support_standard',
  openedWithIncident: false, tenantContact: 'u1', firstResponseAt: null, createdAt: '2026-11-01T00:00:00Z', closedAt: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  setSupportCaseStatus.mockResolvedValue({ success: true });
});

describe('SupportCasePanel status select', () => {
  it('shows a resolved case as resolved, and choosing Open reopens it', async () => {
    const onChanged = jest.fn<AnyFn>();
    render(<SupportCasePanel supportCase={kase('resolved')} contacts={[]} onChanged={onChanged} />);
    const select = screen.getByRole('combobox', { name: 'Case status' }) as HTMLSelectElement;
    expect(select.value).toBe('resolved');
    expect(screen.getByRole('option', { name: 'resolved' })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'open' } });
    await waitFor(() => expect(setSupportCaseStatus).toHaveBeenCalledWith('t1', 'open'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('adds no extra option for a status the tenant can set', () => {
    render(<SupportCasePanel supportCase={kase('awaiting_customer')} contacts={[]} />);
    expect((screen.getByRole('combobox', { name: 'Case status' }) as HTMLSelectElement).value).toBe('awaiting_customer');
    expect(screen.queryByRole('option', { name: 'resolved' })).not.toBeInTheDocument();
  });

  it('locks every control in a read-only session', () => {
    render(<SupportCasePanel supportCase={kase('open')} contacts={[{ userId: 'u1' }, { userId: 'u2' }]} readOnly />);
    expect(screen.getByRole('combobox', { name: 'Case status' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Hand over to another support contact' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close case' })).toBeDisabled();
  });
});
