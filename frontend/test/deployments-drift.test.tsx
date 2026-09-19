// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deployment drift is joined against EVERY pipeline config (cursor-drained,
 * three columns), not one capped page — a config past the old 200-row cap used
 * to read as "Orphaned" and the banner urged deregistering a valid record.
 */

import { render, screen } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import DeploymentsPage from '../pages/dashboard/deployments';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const listAllPipelines = jest.fn();
const listPipelineDeployments = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listAllPipelines: (...a: unknown[]) => listAllPipelines(...a),
    listPipelineDeployments: (...a: unknown[]) => listPipelineDeployments(...a),
  },
}));

beforeEach(() => {
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => false });
  listPipelineDeployments.mockResolvedValue({
    success: true,
    data: {
      registry: [{ id: 'r1', pipelineId: 'p-250', pipelineName: 'late-pipeline', lastDeployed: '2026-01-01T00:00:00Z' }],
      pagination: { total: 1, limit: 200, offset: 0, hasMore: false },
    },
  });
});

it('marks a deployment in sync when its config exists anywhere in the org', async () => {
  listAllPipelines.mockResolvedValue([{ id: 'p-250', pipelineName: 'late-pipeline', project: 'x', organization: 'y' }]);

  render(<DeploymentsPage />);

  // The filter <select> also lists every status, so look at the row badge only.
  const badge = (label: string) => screen.queryAllByText(label).filter((el) => el.tagName !== 'OPTION');
  await screen.findByText('late-pipeline');
  expect(await screen.findAllByText('In sync')).toHaveLength(2);
  expect(badge('In sync')).toHaveLength(1);
  expect(badge('Orphaned')).toHaveLength(0);
  expect(listAllPipelines).toHaveBeenCalledWith(['pipelineName', 'project', 'organization'], undefined, expect.anything());
});

it('says "unknown", never "orphaned", when the configs could not be loaded', async () => {
  listAllPipelines.mockRejectedValue(new Error('pipeline service down'));

  render(<DeploymentsPage />);

  const badge = (label: string) => screen.queryAllByText(label).filter((el) => el.tagName !== 'OPTION');
  await screen.findByText('late-pipeline');
  await screen.findAllByText('Unknown');
  expect(badge('Unknown')).toHaveLength(1);
  expect(badge('Orphaned')).toHaveLength(0);
});
