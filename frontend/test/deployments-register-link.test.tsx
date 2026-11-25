// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/dashboard/deployments?register=<pipelineId>` — the pipeline page's
 * "Register deployment" link for a pipeline that was deployed but has no
 * registration. It opens the Register deployment form with that pipeline
 * already chosen, then drops the param so a refresh doesn't reopen it.
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import DeploymentsPage from '../pages/dashboard/deployments';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/deployments', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const listAllPipelines = jest.fn<AnyFn>();
const listPipelineDeployments = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAllPipelines: (...a: unknown[]) => listAllPipelines(...a),
    listPipelineDeployments: (...a: unknown[]) => listPipelineDeployments(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  listAllPipelines.mockResolvedValue([
    { id: 'p-1', pipelineName: 'web-pipeline', project: 'web', organization: 'acme' },
    { id: 'p-2', pipelineName: 'api-pipeline', project: 'api', organization: 'acme' },
  ]);
  listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [], pagination: { total: 0, limit: 200, offset: 0, hasMore: false } } });
});

it('opens Register deployment with the named pipeline chosen, and strips the param', async () => {
  mockRouter.query = { register: 'p-2' };
  render(<DeploymentsPage />);

  const select = await screen.findByLabelText('Pipeline');
  await screen.findByRole('option', { name: /api-pipeline/ });
  expect(select).toHaveValue('p-2');
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/dashboard/deployments', query: {} }, undefined, { shallow: true });
});

it('does not open the form without the param', async () => {
  mockRouter.query = {};
  render(<DeploymentsPage />);
  await screen.findAllByRole('button', { name: 'Register deployment' });
  expect(screen.queryByLabelText('Pipeline')).not.toBeInTheDocument();
});
