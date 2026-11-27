// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox aggregates independent sources. They load in parallel (one slow
 * source must not delay the others' requests), and a failing source only
 * drops its own items.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import InboxPage from '../src/components/inbox/NotificationsTab';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());

const listAllPipelines = jest.fn<AnyFn>();
const getExecutionCount = jest.fn<AnyFn>();
const getExemptions = jest.fn<AnyFn>();
const getUnreadCount = jest.fn<AnyFn>();
const listPluginRemediations = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAllPipelines: (...a: unknown[]) => listAllPipelines(...a),
    getExecutionCount: (...a: unknown[]) => getExecutionCount(...a),
    getExemptions: (...a: unknown[]) => getExemptions(...a),
    getUnreadCount: (...a: unknown[]) => getUnreadCount(...a),
    listPluginRemediations: (...a: unknown[]) => listPluginRemediations(...a),
  },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('InboxPage', () => {
  beforeEach(() => {
    mockAuthGuard({ user: { id: 'me', organizationId: 'org-1' }, can: () => true });
    listPluginRemediations.mockReset().mockResolvedValue({ success: true, data: { remediations: [] } });
  });

  it('requests every source in parallel, not one after another', async () => {
    const pipelines = deferred<unknown>();
    const exemptions = deferred<unknown>();
    const unread = deferred<unknown>();
    listAllPipelines.mockReturnValue(pipelines.promise);
    getExecutionCount.mockReturnValue(new Promise(() => {}));
    getExemptions.mockReturnValue(exemptions.promise);
    getUnreadCount.mockReturnValue(unread.promise);

    render(<InboxPage />);

    // Nothing has resolved yet, and all three sources are already in flight.
    await waitFor(() => expect(getUnreadCount).toHaveBeenCalled());
    expect(listAllPipelines).toHaveBeenCalled();
    expect(getExemptions).toHaveBeenCalled();
  });

  it('shows the sources that loaded when another one fails', async () => {
    listAllPipelines.mockRejectedValue(new Error('pipeline service down'));
    getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
    getExemptions.mockResolvedValue({
      success: true,
      data: { exemptions: [{ id: 'ex1', entityType: 'plugin', reason: 'legacy build' }] },
    });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 2 } });

    render(<InboxPage />);

    expect(await screen.findByText('Exemption request pending review (plugin)')).toBeInTheDocument();
    expect(screen.getByText('2 unread messages')).toBeInTheDocument();
    expect(screen.queryByText(/could not load your action items/i)).not.toBeInTheDocument();
  });

  it('reports an error (not "Inbox zero") when every source fails', async () => {
    listAllPipelines.mockRejectedValue(new Error('down'));
    getExecutionCount.mockRejectedValue(new Error('down'));
    getExemptions.mockResolvedValue({ success: false });
    getUnreadCount.mockRejectedValue(new Error('down'));
    listPluginRemediations.mockRejectedValue(new Error('down'));

    render(<InboxPage />);

    expect(await screen.findByText(/could not load your action items/i)).toBeInTheDocument();
    expect(screen.queryByText('Inbox zero')).not.toBeInTheDocument();
    await act(async () => {});
  });

  it('joins failures against EVERY owned pipeline (drained, ids only), not a capped page', async () => {
    listAllPipelines.mockResolvedValue([{ id: 'p-late' }]);
    getExecutionCount.mockResolvedValue({
      success: true,
      data: { pipelines: [{ id: 'p-late', pipeline_name: 'late', project: 'x', failed: 2, succeeded: 1, total: 3 }] },
    });
    getExemptions.mockResolvedValue({ success: true, data: { exemptions: [] } });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 0 } });

    render(<InboxPage />);

    expect(await screen.findByText('late has 2 failed runs')).toBeInTheDocument();
    expect(listAllPipelines).toHaveBeenCalledWith(['id'], { ownerId: 'me' }, expect.anything());
  });

  it('says how many pending exemptions it did not list', async () => {
    listAllPipelines.mockResolvedValue([]);
    getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
    getExemptions.mockResolvedValue({
      success: true,
      data: {
        exemptions: [{ id: 'ex1', entityType: 'plugin', reason: 'r' }],
        pagination: { total: 31, limit: 20, offset: 0, hasMore: true },
      },
    });
    getUnreadCount.mockResolvedValue({ success: true, data: { count: 0 } });

    render(<InboxPage />);

    const more = await screen.findByText('30 more exemption requests pending review');
    expect(more.closest('a')).toHaveAttribute('href', '/dashboard/compliance?view=exemptions');
    expect(getExemptions).toHaveBeenCalledWith({ status: 'pending', limit: 20, offset: 0 });
  });
});

describe('InboxPage — plugin security fixes', () => {
  const rem = (over: Record<string, unknown>) => ({
    id: 'r1', pluginId: 'p1', pluginName: 'terraform-plan', fromVersion: '1.4.2', stage: 'awaiting_approval',
    outcome: null, toVersion: '1.4.3', toPluginId: 'p2', cleared: [{ id: 'CVE-1' }, { id: 'CVE-2' }], remaining: [],
    rollout: null, rolledBackPipelineIds: [], ...over,
  });

  beforeEach(() => {
    mockAuthGuard({ user: { id: 'me', organizationId: 'org-1' }, can: (p: string) => p === 'plugins:read' });
    listPluginRemediations.mockReset();
  });

  it('lists fixes awaiting approval, owner requests, paused rollouts and rollbacks, each linking to the remediation', async () => {
    listPluginRemediations.mockResolvedValue({
      success: true,
      data: {
        remediations: [
          rem({}),
          rem({ id: 'r2', stage: 'needs_owner', toVersion: null, remaining: [{ id: 'CVE-3' }] }),
          rem({ id: 'r3', stage: 'needs_review', rollout: { counts: { rolledBack: 2 } } }),
        ],
      },
    });
    render(<InboxPage />);
    const approval = await screen.findByText('Security fix for terraform-plan 1.4.2 is awaiting approval');
    expect(approval.closest('a')?.getAttribute('href')).toBe('/dashboard/plugins?tab=security&section=remediations&remediation=r1');
    expect(screen.getByText('terraform-plan 1.4.2 needs its owner to fix 1 finding').closest('a')?.getAttribute('href'))
      .toBe('/dashboard/plugins?tab=security&section=remediations&remediation=r2');
    expect(screen.getByText('Rollout of terraform-plan 1.4.3 is paused and needs review')).toBeInTheDocument();
    expect(screen.getByText('2 pipelines were rolled back from terraform-plan 1.4.3').closest('a')?.getAttribute('href'))
      .toBe('/dashboard/plugins?tab=security&section=remediations&remediation=r3');
    expect(listPluginRemediations).toHaveBeenCalledWith({ stage: 'awaiting_approval,needs_owner,needs_review,rolling_out', limit: 50 });
  });

  it('does not ask without plugins:read', async () => {
    mockAuthGuard({ user: { id: 'me', organizationId: 'org-1' }, can: () => false });
    render(<InboxPage />);
    await screen.findByText('Inbox zero');
    expect(listPluginRemediations).not.toHaveBeenCalled();
  });
});
