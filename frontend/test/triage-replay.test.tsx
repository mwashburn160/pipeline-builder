// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build triage: a replayed DLQ sample loses its Replay button.
 *
 * The triage read is memoized server-side for a few seconds, so the refresh
 * after a replay can still list the sample — while its source job is gone, so
 * a second Replay could only answer "DLQ job … not found".
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ query: {}, pathname: '/dashboard/triage', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() })));

const getQueueTriage = jest.fn<AnyFn>();
const replayDlqJob = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = {
    getQueueTriage: (...a: unknown[]) => getQueueTriage(...a),
    replayDlqJob: (...a: unknown[]) => replayDlqJob(...a),
  };
  return { __esModule: true, default: api, api };
});

import TriagePage from '../pages/dashboard/triage';

describe('triage — DLQ replay', () => {
  it('drops the Replay button once the job is re-enqueued, even when the refresh still lists it', async () => {
    mockAuthGuard({ can: () => true });
    // The same (cached) answer before and after the replay.
    getQueueTriage.mockResolvedValue({ success: true, data: { totalFailed: 1, groups: [{
      category: 'other', count: 1, pluginNames: ['scan'],
      samples: [{ id: 'dlq-1', pluginName: 'scan', version: null, error: 'boom', failedAt: null, source: 'dlq' }],
    }] } });
    replayDlqJob.mockResolvedValue({ success: true, data: { newJobId: 'n9' } });

    render(<TriagePage />);
    fireEvent.click(await screen.findByText(/1 failure$/));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));
    expect(await screen.findByText('Re-enqueued as job n9')).toBeInTheDocument();
    await waitFor(() => expect(getQueueTriage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Replay' })).not.toBeInTheDocument();
    expect(replayDlqJob).toHaveBeenCalledTimes(1);
  });
});
