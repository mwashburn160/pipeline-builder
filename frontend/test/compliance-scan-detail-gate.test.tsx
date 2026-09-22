// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ScanDetail's "Cancel scan" against what the compliance service enforces.
 *
 * `POST /compliance/scans/:id/cancel` is `compliance:write` — the same gate
 * ScanManager's row-level cancel icon already honoured. The detail view is the
 * twin that was reachable with `compliance:read` alone, so it takes the page's
 * `readOnly` too and hides the action rather than offering a guaranteed 403.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ScanDetail from '../src/components/compliance/ScanDetail';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() })));

const getScan = jest.fn<AnyFn>();
const cancelScan = jest.fn<AnyFn>();
const getComplianceAuditLog = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getScan: (...a: unknown[]) => getScan(...a),
    cancelScan: (...a: unknown[]) => cancelScan(...a),
    getComplianceAuditLog: (...a: unknown[]) => getComplianceAuditLog(...a),
    createExemption: jest.fn<AnyFn>(),
  },
}));

const runningScan = {
  id: 'scan-1', orgId: 'o1', target: 'plugin', status: 'running', triggeredBy: 'manual', userId: 'u1',
  totalEntities: 10, processedEntities: 4, passCount: 3, warnCount: 1, blockCount: 0,
  startedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  getScan.mockResolvedValue({ success: true, data: { scan: runningScan } });
  getComplianceAuditLog.mockResolvedValue({ success: true, data: { entries: [], pagination: { total: 0, limit: 25, offset: 0 } } });
  cancelScan.mockResolvedValue({ success: true });
});

it('offers Cancel scan on a running scan for a compliance:write viewer', async () => {
  render(<ScanDetail scanId="scan-1" onBack={jest.fn<AnyFn>()} />);
  fireEvent.click(await screen.findByRole('button', { name: /cancel scan/i }));

  // Confirms first — the scan cannot be resumed.
  expect(cancelScan).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Cancel scan')!);
  await waitFor(() => expect(cancelScan).toHaveBeenCalledWith('scan-1'));
});

it('hides Cancel scan for a read-only viewer', async () => {
  render(<ScanDetail scanId="scan-1" onBack={jest.fn<AnyFn>()} readOnly />);

  // The detail itself still renders — reading a scan is `compliance:read`.
  await screen.findByText('Scan details');
  expect(screen.queryByRole('button', { name: /cancel scan/i })).not.toBeInTheDocument();
  expect(cancelScan).not.toHaveBeenCalled();
});
