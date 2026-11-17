// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ScanScheduleManager create form: Enter in the cron field submits the form
 * directly (the disabled/loading submit button does not stand in the way), so
 * a second submit while the first create is in flight must not POST again.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ScanScheduleManager from '../src/components/compliance/ScanScheduleManager';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getScanSchedules = jest.fn<AnyFn>();
const createScanSchedule = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getScanSchedules: (...a: unknown[]) => getScanSchedules(...a),
    createScanSchedule: (...a: unknown[]) => createScanSchedule(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  getScanSchedules.mockResolvedValue({ success: true, data: { schedules: [] } });
});

describe('ScanScheduleManager create', () => {
  it('creates once when the form is submitted twice while the first create is in flight', async () => {
    let finish!: (v: unknown) => void;
    createScanSchedule.mockImplementation(() => new Promise((r) => { finish = r; }));

    render(<ScanScheduleManager />);
    await waitFor(() => expect(screen.queryByLabelText('Loading scan schedules')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /new schedule/i }));

    const form = screen.getByLabelText('Cron expression (UTC)').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(createScanSchedule).toHaveBeenCalledTimes(1);

    finish({ success: true });
    await waitFor(() => expect(getScanSchedules).toHaveBeenCalledTimes(2));
    expect(createScanSchedule).toHaveBeenCalledTimes(1);
  });
});
