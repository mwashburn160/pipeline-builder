// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Compliance Overview posture counts: a failed count read is an error, never a 0.
 * The headline is the worst of pass/warn/block, so computing it from a partial set
 * turned a failed (or rate-limited) `block` read into a green "All clear".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ComplianceDashboard from '../src/components/compliance/ComplianceDashboard';

jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: {}, pathname: '/', replace: jest.fn<AnyFn>() })));

let counts: Record<string, () => Promise<unknown>>;
const getComplianceAuditLog = jest.fn<AnyFn>((params?: { result?: string }) => {
  if (params?.result) return counts[params.result]();
  return Promise.resolve({ success: true, data: { entries: [], pagination: { limit: 25, offset: 0, total: 0 } } });
});
const getComplianceRules = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getComplianceAuditLog: (...a: unknown[]) => getComplianceAuditLog(...(a as [{ result?: string }])),
    getComplianceRules: (...a: unknown[]) => getComplianceRules(...a),
  },
}));

const total = (n: number) => () => Promise.resolve({ success: true, data: { entries: [], pagination: { total: n } } });

beforeEach(() => {
  counts = { pass: total(12), warn: total(0), block: total(0) };
  getComplianceRules.mockReset().mockResolvedValue({ success: true, data: { rules: [], pagination: { total: 4 } } });
});

describe('ComplianceOverview counts', () => {
  it('reads "All clear" from a complete, clean set of counts', async () => {
    render(<ComplianceDashboard />);
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('a failed block count shows an error, not "All clear" and not a 0', async () => {
    counts.block = () => Promise.reject(new Error('429 Too Many Requests'));
    render(<ComplianceDashboard />);
    expect(await screen.findByText('Posture unavailable')).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(screen.getByText(/429 Too Many Requests/)).toBeInTheDocument();
    // Pass/Warn/Blocked all show a dash: the set is incomplete, so none is claimed.
    const blocked = screen.getByText('Blocked').previousElementSibling;
    expect(blocked).toHaveTextContent('—');
  });

  it('an unsuccessful response (no total) is a failure too', async () => {
    counts.warn = () => Promise.resolve({ success: false, message: 'compliance unavailable' });
    render(<ComplianceDashboard />);
    expect(await screen.findByText(/compliance unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });

  it('a failed rules count shows a dash, and Retry re-reads', async () => {
    getComplianceRules.mockReset().mockResolvedValueOnce({ success: false, message: 'rules down' })
      .mockResolvedValue({ success: true, data: { rules: [], pagination: { total: 7 } } });
    render(<ComplianceDashboard />);
    expect(await screen.findByText(/rules down/)).toBeInTheDocument();
    expect(screen.getByText('Active rules').previousElementSibling).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('Active rules').previousElementSibling).toHaveTextContent('7'));
  });
});
