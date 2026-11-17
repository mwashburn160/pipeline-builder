// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Purging the whole DLQ is step-up gated on the server. The page's own
 * StepUpModal mints the token, so the page must hand THAT token to the purge
 * call — dropping it sent a bare DELETE the server refuses — and the API call
 * must carry it as `X-Step-Up-Token` without offering itself for a second,
 * global replay.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import BuildQueuePage from '../pages/dashboard/build-queue';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/usePolling', () => ({ __esModule: true, usePolling: () => {} }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
  ),
}));

const purgeDlq = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getQueueStatus: () => Promise.resolve({
      data: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, dlq: { waiting: 3, active: 0, failed: 0, delayed: 0 } },
    }),
    getQueueFailed: () => Promise.resolve({ data: { jobs: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
    getQueueDlq: () => Promise.resolve({ data: { jobs: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } } }),
    purgeDlq: (...a: unknown[]) => purgeDlq(...a),
  },
}));

beforeEach(() => {
  mockAuthGuard({ isSuperAdmin: true, isAdmin: true, user: { id: 'op', organizationId: 'system' } });
  purgeDlq.mockReset().mockResolvedValue({ success: true, data: { message: 'ok' } });
});

it('passes the step-up token from the confirm dialog to the purge call', async () => {
  render(<BuildQueuePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Purge DLQ' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
  await waitFor(() => expect(purgeDlq).toHaveBeenCalledWith('step-up-token'));
});

describe('api.purgeDlq', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('sends the token as X-Step-Up-Token and is not offered for global replay', async () => {
    const { ApiCore } = jest.requireActual<typeof import('../src/lib/api/core')>('../src/lib/api/core');
    const { pluginsApi } = jest.requireActual<typeof import('../src/lib/api/domains/plugins')>('../src/lib/api/domains/plugins');
    const fetchMock = jest.fn<AnyFn>(() => Promise.resolve({
      status: 401, ok: false,
      json: async () => ({ code: 'STEP_UP_REQUIRED', message: 'Confirm it is you' }),
    } as unknown as Response));
    global.fetch = fetchMock as unknown as typeof fetch;
    const seen: unknown[] = [];
    const listener = (e: Event) => { e.preventDefault(); seen.push(e); };
    window.addEventListener('step-up-required', listener);

    const core = new ApiCore();
    const err = await pluginsApi(core).purgeDlq('tok').catch((e: unknown) => e);
    window.removeEventListener('step-up-required', listener);

    expect(err).toBeTruthy();
    expect(seen).toHaveLength(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/plugins/queue/dlq');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['X-Step-Up-Token']).toBe('tok');
  });
});
