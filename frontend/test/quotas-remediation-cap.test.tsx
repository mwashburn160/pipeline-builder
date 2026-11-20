// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { RemediationCapCard } from '../src/components/quotas/RemediationCapCard';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const listPluginRemediations = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { listPluginRemediations: (...a: unknown[]) => listPluginRemediations(...a) },
}));

const LIST = { remediations: [], nextCursor: null, enabled: true, severities: ['critical', 'high'], usedToday: 3, maxPerDay: 20 };

beforeEach(() => {
  listPluginRemediations.mockReset();
  mockAuthGuard({ can: (p: string) => p === 'plugins:read' });
});

describe('the daily remediation cap on the quotas page', () => {
  it('shows remediations used today out of the cap', async () => {
    listPluginRemediations.mockResolvedValue({ success: true, data: LIST });
    render(<RemediationCapCard />);
    expect(await screen.findByText('3 of 20')).toBeInTheDocument();
    expect(listPluginRemediations).toHaveBeenCalledWith({ limit: 1 }, expect.anything());
  });

  it('says the cap is reached', async () => {
    listPluginRemediations.mockResolvedValue({ success: true, data: { ...LIST, usedToday: 20 } });
    render(<RemediationCapCard />);
    expect(await screen.findByText(/Cap reached/)).toBeInTheDocument();
  });

  it('shows the operator-off state when the deployment knob is off', async () => {
    listPluginRemediations.mockResolvedValue({ success: true, data: { ...LIST, enabled: false } });
    render(<RemediationCapCard />);
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeInTheDocument();
    expect(screen.queryByText('3 of 20')).toBeNull();
  });

  it('renders nothing when the read fails, and does not ask without plugins:read', async () => {
    listPluginRemediations.mockRejectedValue(new Error('503'));
    const { container, unmount } = render(<RemediationCapCard />);
    await waitFor(() => expect(listPluginRemediations).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    unmount();
    listPluginRemediations.mockReset();
    mockAuthGuard({ can: () => false });
    const second = render(<RemediationCapCard />);
    expect(second.container.textContent).toBe('');
    expect(listPluginRemediations).not.toHaveBeenCalled();
  });
});
