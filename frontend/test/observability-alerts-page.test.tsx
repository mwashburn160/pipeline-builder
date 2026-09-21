// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alerts page: expiring a silence re-arms its alerts immediately, so it goes
 * through a confirm dialog — Cancel leaves the silence alone, Confirm expires it.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertsPage from '../pages/dashboard/observability/alerts';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const observabilityDeleteSilence = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: {
    observabilityAlerts: jest.fn<AnyFn>().mockResolvedValue({ data: { alerts: [] } }),
    observabilitySilences: jest.fn<AnyFn>().mockResolvedValue({
      data: {
        silences: [{
          id: 'sil-1',
          matchers: [{ name: 'alertname', value: 'HighErrors' }],
          comment: 'deploy window',
          createdBy: 'ops@example.com',
          startsAt: '2026-09-19T00:00:00Z',
          endsAt: '2099-01-01T00:00:00Z',
          status: { state: 'active' },
        }],
      },
    }),
    observabilityDeleteSilence: (...a: unknown[]) => observabilityDeleteSilence(...a),
  },
}));

beforeEach(() => {
  observabilityDeleteSilence.mockReset().mockResolvedValue({ success: true });
  mockAuthGuard({ can: (p: string) => p === 'observability:write' });
});

describe('AlertsPage — expire silence', () => {
  it('asks for confirmation and does nothing on Cancel', async () => {
    render(<AlertsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expire' }));
    expect(await screen.findByText(/expire silence\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText(/expire silence\?/i)).not.toBeInTheDocument());
    expect(observabilityDeleteSilence).not.toHaveBeenCalled();
  });

  it('expires the silence only after confirming', async () => {
    render(<AlertsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expire' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expire silence' }));
    await waitFor(() => expect(observabilityDeleteSilence).toHaveBeenCalledWith('sil-1'));
  });

  it('shows the empty state when nothing is firing', async () => {
    render(<AlertsPage />);
    expect(await screen.findByText('No alerts firing')).toBeInTheDocument();
  });
});
