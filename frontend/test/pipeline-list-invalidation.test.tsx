// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline writes must drop the shared pipeline cache (command palette, home,
 * deployments drift, inbox), and the catalog list must ask only for the columns
 * it renders.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import PipelinesPage from '../pages/dashboard/pipelines';
import PipelineDetailPage from '../pages/dashboard/pipelines/[id]';
import { PIPELINE_LIST_FIELDS } from '../src/lib/api/domains/pipelines';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: false, isLoaded: true, label: 'x', description: '', unlocks: '', upsellHref: '/', reason: 'not on plan' }),
}));
jest.mock('@/components/pipeline/DeployedPipelinesPanel', () => ({ __esModule: true, DeployedPipelinesPanel: () => null }));
jest.mock('@/components/pipeline/ScorecardCard', () => ({ __esModule: true, ScorecardCard: () => null }));
jest.mock('@/components/pipeline/PipelineContextCard', () => ({ __esModule: true, PipelineContextCard: () => null }));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines', isReady: true, replace: jest.fn(), push: jest.fn() };
jest.mock('next/router', () => ({ __esModule: true, useRouter: () => mockRouter }));

const invalidatePipelines = jest.fn();
jest.mock('@/lib/api-cache', () => {
  const actual = jest.requireActual('@/lib/api-cache');
  return { __esModule: true, ...actual, invalidate: { ...actual.invalidate, pipelines: () => invalidatePipelines() } };
});

const listPipelines = jest.fn();
const deletePipeline = jest.fn();
const getPipelineById = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPipelines: (...a: unknown[]) => listPipelines(...a),
    deletePipeline: (...a: unknown[]) => deletePipeline(...a),
    getPipelineById: (...a: unknown[]) => getPipelineById(...a),
    getExecutionCount: () => Promise.resolve({ success: true, data: { pipelines: [] } }),
    getOrganizationMembers: () => Promise.resolve({ success: true, data: { members: [] } }),
    listPipelineDeployments: () => Promise.resolve({ success: true, data: { registry: [], pagination: { hasMore: false } } }),
    listPipelineExecutions: () => Promise.resolve({ success: true, data: { executions: [] } }),
  },
}));

const row = {
  id: 'p1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'web-pipeline', keywords: [],
  visibility: 'org', isActive: true, isDefault: false, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z',
  updatedBy: 'u1', updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  invalidatePipelines.mockClear();
  mockRouter.push.mockClear();
  mockAuthGuard({
    user: { id: 'u1', organizationId: 'org-1' },
    can: (p: string) => p === 'pipelines:write' || p === 'pipelines:read',
  });
  listPipelines.mockReset().mockResolvedValue({ success: true, data: { pipelines: [row], pagination: { total: 1, limit: 25, offset: 0, hasMore: false } } });
  deletePipeline.mockReset().mockResolvedValue({ success: true });
});

describe('pipelines catalog', () => {
  it('requests the list columns only — never `props`', async () => {
    mockRouter.pathname = '/dashboard/pipelines';
    mockRouter.query = {};
    render(<PipelinesPage />);
    await screen.findByText('web-pipeline');

    const params = listPipelines.mock.calls[0][0] as Record<string, string>;
    expect(params.fields.split(',')).toEqual([...PIPELINE_LIST_FIELDS]);
    expect(params.fields.split(',')).not.toContain('props');
  });

  it('drops the shared pipeline cache after a delete', async () => {
    mockRouter.pathname = '/dashboard/pipelines';
    mockRouter.query = {};
    render(<PipelinesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete pipeline' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(deletePipeline).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(invalidatePipelines).toHaveBeenCalled());
  });
});

describe('pipelines catalog filters', () => {
  it('offers no Organization or Keyword filters, and ignores those URL params', async () => {
    mockRouter.pathname = '/dashboard/pipelines';
    mockRouter.query = { organization: 'acme', keyword: 'deploy' };
    render(<PipelinesPage />);
    await screen.findByText('web-pipeline');

    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.queryByLabelText('Filter by organization')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter by keyword')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter by project')).toBeInTheDocument();

    const params = listPipelines.mock.calls[0][0] as Record<string, string>;
    expect(params).not.toHaveProperty('organization');
    expect(params).not.toHaveProperty('keyword');
  });
});

describe('pipeline detail', () => {
  it('drops the shared pipeline cache before leaving after a delete', async () => {
    mockRouter.pathname = '/dashboard/pipelines/[id]';
    mockRouter.query = { id: 'p1' };
    getPipelineById.mockResolvedValue({ success: true, data: { pipeline: { ...row, props: {} } } });

    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(deletePipeline).toHaveBeenCalledWith('p1'));
    expect(invalidatePipelines).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith('/dashboard/pipelines');
  });
});
