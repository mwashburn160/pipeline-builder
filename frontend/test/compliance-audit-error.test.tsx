// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ComplianceDashboard overview: a failed audit-log fetch must show an error +
 * retry banner instead of the swallowed-error empty state ("No check results
 * recorded yet."), which would read as "nothing happened" rather than "the
 * fetch broke".
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ComplianceDashboard from '../src/components/compliance/ComplianceDashboard';

// The overview issues two kinds of audit-log queries: the list fetch (no
// `result`) and the pass/warn/block COUNT fetches (with `result`). Only the list
// fetch drives the error banner, so route counts to a stable resolve and let the
// test control the list fetch.
let listFetch: () => Promise<unknown>;
const getComplianceAuditLog = jest.fn((params?: { result?: string }) => {
  if (params && params.result) return Promise.resolve({ success: true, data: { pagination: { total: 0 } } });
  return listFetch();
});
const getComplianceRules = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getComplianceAuditLog: (...a: unknown[]) => getComplianceAuditLog(...(a as [{ result?: string }])),
    getComplianceRules: (...a: unknown[]) => getComplianceRules(...a),
  },
}));

const okList = { success: true, data: { entries: [], pagination: { limit: 20, offset: 0, total: 0 } } };

beforeEach(() => {
  listFetch = () => Promise.resolve(okList);
  getComplianceRules.mockReset().mockResolvedValue({ success: true, data: { pagination: { total: 0 } } });
});

describe('ComplianceDashboard — audit fetch error', () => {
  it('shows an error + retry banner when the audit fetch rejects', async () => {
    listFetch = () => Promise.reject(new Error('boom'));

    render(<ComplianceDashboard />);

    expect(await screen.findByText(/failed to load audit log/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/no check results recorded yet/i)).not.toBeInTheDocument();
  });

  it('clears the banner and refetches on Retry', async () => {
    listFetch = () => Promise.reject(new Error('boom'));
    render(<ComplianceDashboard />);
    await screen.findByText(/failed to load audit log/i);

    listFetch = () => Promise.resolve(okList);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/failed to load audit log/i)).not.toBeInTheDocument());
    expect(screen.getByText(/no check results recorded yet/i)).toBeInTheDocument();
  });
});
