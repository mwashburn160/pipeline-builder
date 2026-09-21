// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ScanManager: the `triggeredBy` list filter reaches the API, and cancelling a
 * running scan asks first (it can't be resumed) instead of firing on one click.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ScanManager from '../src/components/compliance/ScanManager';

jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() }),
}));

const getScans = jest.fn<AnyFn>();
const cancelScan = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getScans: (...a: unknown[]) => getScans(...a),
    cancelScan: (...a: unknown[]) => cancelScan(...a),
    triggerScan: jest.fn<AnyFn>(),
  },
}));

const runningScan = {
  id: 'scan-1', orgId: 'o1', target: 'plugin', status: 'running', triggeredBy: 'manual',
  totalEntities: 10, processedEntities: 4, passCount: 3, warnCount: 1, blockCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  getScans.mockResolvedValue({ success: true, data: { scans: [runningScan], pagination: { total: 1, limit: 10, offset: 0 } } });
  cancelScan.mockResolvedValue({ success: true });
});

it('forwards the triggeredBy filter to the scan list', async () => {
  render(<ScanManager />);
  await screen.findByRole('button', { name: 'Cancel scan' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Filter scans by trigger' }), { target: { value: 'scheduled' } });
  await waitFor(() => expect(getScans).toHaveBeenLastCalledWith(expect.objectContaining({ triggeredBy: 'scheduled' })));
});

it('confirms before cancelling a running scan', async () => {
  render(<ScanManager />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
  expect(cancelScan).not.toHaveBeenCalled();
  expect(screen.getByText(/can.t be resumed/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
  expect(cancelScan).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Cancel scan')!);
  await waitFor(() => expect(cancelScan).toHaveBeenCalledWith('scan-1'));
});
