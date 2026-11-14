// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline detail page is reached by same-pathname navigation (⌘K from
 * pipeline A to pipeline B), which does not remount it. Once the URL says B,
 * nothing of A may stay on screen — not its name, not its runs, and above all
 * not its actions (Delete used to delete A while Run triggered B) — and a
 * failed read for B must show its error instead of hiding behind A.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import PipelineDetailPage from '../pages/dashboard/pipelines/[id]';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/components/pipeline/ScorecardCard', () => ({ __esModule: true, ScorecardCard: () => null }));
jest.mock('@/components/pipeline/PipelineContextCard', () => ({ __esModule: true, PipelineContextCard: () => null }));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines/[id]', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const getPipelineById = jest.fn<AnyFn>();
const listPipelineExecutions = jest.fn<AnyFn>();
const deletePipeline = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPipelineById: (...a: unknown[]) => getPipelineById(...a),
    getExecutionCount: () => Promise.resolve({ success: true, data: { pipelines: [] } }),
    getOrganizationMembers: () => Promise.resolve({ success: true, data: { members: [] } }),
    listPipelineDeployments: () => Promise.resolve({ success: true, data: { registry: [], pagination: { hasMore: false } } }),
    listPipelineExecutions: (...a: unknown[]) => listPipelineExecutions(...a),
    getPipelineSecurity: () => Promise.resolve({ success: true, data: null }),
    deletePipeline: (...a: unknown[]) => deletePipeline(...a),
  },
}));

const pipelineA = {
  id: 'pA', orgId: 'org-1', project: 'alpha', organization: 'acme', pipelineName: 'alpha-pipeline', keywords: [], props: {},
  visibility: 'org', isActive: true, isDefault: false, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-01-01T00:00:00Z',
};
const execA = { execution_id: 'exec-of-A', status: 'running', started_at: '2026-11-10T00:00:00Z', ended_at: null, duration_ms: 1, failing_stage: null, failing_action: null };

beforeEach(() => {
  getPipelineById.mockReset();
  listPipelineExecutions.mockReset();
  deletePipeline.mockReset();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
});

describe('pipeline detail: switching to another id in the same mount', () => {
  it('drops A and its actions, and shows B\'s load error, when B fails to load', async () => {
    getPipelineById.mockImplementation((id: unknown) => (id === 'pA'
      ? Promise.resolve({ success: true, data: { pipeline: pipelineA } })
      : Promise.resolve({ success: false, message: 'Pipeline not found' })));
    listPipelineExecutions.mockResolvedValue({ success: true, data: { executions: [] } });
    mockRouter.query = { id: 'pA' };
    const { rerender } = render(<PipelineDetailPage />);
    expect(await screen.findByRole('button', { name: /Delete/ })).toBeInTheDocument();

    mockRouter.query = { id: 'pB' };
    rerender(<PipelineDetailPage />);

    expect(await screen.findByText(/Pipeline not found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByText('alpha-pipeline')).not.toBeInTheDocument();
    expect(deletePipeline).not.toHaveBeenCalled();
  });

  it('does not list A\'s runs (with their Stop buttons) while B\'s runs load', async () => {
    getPipelineById.mockImplementation((id: unknown) => Promise.resolve({ success: true, data: { pipeline: { ...pipelineA, id, pipelineName: `${String(id)}-pipeline` } } }));
    listPipelineExecutions.mockImplementation((id: unknown) => (id === 'pA'
      ? Promise.resolve({ success: true, data: { executions: [execA] } })
      : new Promise(() => {})));
    mockRouter.query = { id: 'pA', tab: 'runs' };
    const { rerender } = render(<PipelineDetailPage />);
    expect(await screen.findByText('exec-of-A')).toBeInTheDocument();

    mockRouter.query = { id: 'pB', tab: 'runs' };
    rerender(<PipelineDetailPage />);
    await waitFor(() => expect(listPipelineExecutions).toHaveBeenCalledWith('pB', expect.anything(), expect.anything()));
    expect(screen.queryByText('exec-of-A')).not.toBeInTheDocument();
  });

});
