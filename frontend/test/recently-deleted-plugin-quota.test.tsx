// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Restoring a deleted plugin version re-charges a `plugins` quota slot (delete
 * refunded it), so the restore route can now answer 429 at the cap or 503 when
 * the quota service cannot be read. Both must reach the user in the server's
 * own words — the same sentence an upload refused at the cap shows — rather
 * than a generic "Failed to restore plugin".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecentlyDeletedPanel } from '../src/components/RecentlyDeletedPanel';
import { ApiError, QuotaExceededError } from '../src/lib/api/errors';
import { pageToast } from './helpers/pageMocks';

const listDeletedPlugins = jest.fn<AnyFn>();
const restorePlugin = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listDeletedPlugins: (...a: unknown[]) => listDeletedPlugins(...a),
    restorePlugin: (...a: unknown[]) => restorePlugin(...a),
    purgePlugin: jest.fn<AnyFn>(),
  },
}));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button onClick={() => onConfirmed('stepup-token')}>confirm-step-up</button>
  ),
}));

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

beforeEach(() => {
  jest.clearAllMocks();
  listDeletedPlugins.mockResolvedValue({ success: true, data: { plugins: [
    { id: 'p1', name: 'node-build', version: '1.2.0', visibility: 'org', createdBy: 'u1', deletedAt: '2026-11-10T10:00:00Z', deletedBy: 'u1' },
  ] } });
});

async function restoreFirst(): Promise<void> {
  render(<RecentlyDeletedPanel resource="plugin" />);
  await screen.findByText('node-build');
  fireEvent.click(screen.getByRole('button', { name: /restore/i }));
  fireEvent.click(screen.getByText('confirm-step-up'));
  await waitFor(() => expect(restorePlugin).toHaveBeenCalledWith('p1', 'stepup-token'));
}

describe('RecentlyDeletedPanel — plugin restore refused by quota', () => {
  it('shows the 429 quota sentence, not a generic failure', async () => {
    const message = 'Plugin quota reached (10/10); resets 2026-11-15. Upgrade at /dashboard/billing.';
    restorePlugin.mockRejectedValue(new QuotaExceededError(message, { quotaType: 'plugins', limit: 10, used: 10 }));
    await restoreFirst();
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(message));
    expect(pageToast.success).not.toHaveBeenCalled();
  });

  it('shows the 503 quota-unavailable message', async () => {
    const message = 'Quota service unavailable; try again shortly.';
    restorePlugin.mockRejectedValue(new ApiError(message, 503, 'QUOTA_SERVICE_UNAVAILABLE'));
    await restoreFirst();
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith(message));
  });
});
