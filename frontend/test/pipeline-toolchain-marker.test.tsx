// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline detail page's run history carries a "toolchain X → Y" marker on
 * the first run after a deploy changed the toolchain release (the Build image
 * row's `change`, derived from consecutive build-image manifest entries) — and
 * nothing when the release never changed.
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

const getPipelineSecurity = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPipelineById: () => Promise.resolve({
      success: true,
      data: {
        pipeline: {
          id: 'p1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'web-pipeline', keywords: [], props: {},
          visibility: 'org', isActive: true, isDefault: false, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    }),
    getExecutionCount: () => Promise.resolve({ success: true, data: { pipelines: [] } }),
    getOrganizationMembers: () => Promise.resolve({ success: true, data: { members: [] } }),
    listPipelineDeployments: () => Promise.resolve({ success: true, data: { registry: [], pagination: { hasMore: false } } }),
    listPipelineExecutions: () => Promise.resolve({
      success: true,
      data: {
        executions: [
          { execution_id: 'e-after-2', status: 'succeeded', started_at: '2026-11-11T00:00:00Z', ended_at: null, duration_ms: 1000, failing_stage: null, failing_action: null },
          { execution_id: 'e-after-1', status: 'succeeded', started_at: '2026-11-10T09:05:00Z', ended_at: null, duration_ms: 1000, failing_stage: null, failing_action: null },
          { execution_id: 'e-before', status: 'failed', started_at: '2026-11-09T00:00:00Z', ended_at: null, duration_ms: 1000, failing_stage: null, failing_action: null },
        ],
      },
    }),
    getPipelineSecurity: (...a: unknown[]) => getPipelineSecurity(...a),
  },
}));

const security = (change: unknown) => Promise.resolve({ success: true, data: { pipeline: { id: 'p1', name: 'web' }, severity: 'ok', steps: [], exposures: [], buildImage: { change } } });

beforeEach(() => {
  getPipelineSecurity.mockReset();
  mockRouter.query = { id: 'p1', tab: 'runs' };
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p === 'pipelines:read' });
});

describe('run history toolchain marker', () => {
  it('marks the first run after the release changed, and only that run', async () => {
    getPipelineSecurity.mockReturnValue(security({ from: '1.4.1', to: '1.4.2', changedAt: '2026-11-10T09:00:00Z' }));
    render(<PipelineDetailPage />);
    expect(await screen.findByTestId('toolchain-marker-e-after-1')).toHaveTextContent('toolchain 1.4.1 → 1.4.2');
    expect(screen.queryByTestId('toolchain-marker-e-after-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolchain-marker-e-before')).not.toBeInTheDocument();
  });

  it('shows no marker when the release never changed', async () => {
    getPipelineSecurity.mockReturnValue(security(null));
    render(<PipelineDetailPage />);
    await screen.findByText('e-after-1');
    await waitFor(() => expect(getPipelineSecurity).toHaveBeenCalled());
    expect(screen.queryByText(/toolchain .* →/)).not.toBeInTheDocument();
  });
});
