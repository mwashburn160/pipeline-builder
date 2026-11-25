// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page × deploying through a pipeline runner.
 *  - A never-deployed pipeline (registration.registered false, no events) the
 *    viewer may edit shows the deploy panel under the "Not deployed yet"
 *    banner (whose CLI command stays); a deployed one, a deployed-but-
 *    unregistered one, or a read-only viewer does not.
 *  - A deploy that finishes reloads the pipeline (its registration).
 *  - Delete (change 5): a deployed pipeline's stack keeps running after a
 *    delete; the dialog says whether purging it later removes the stack
 *    through its runner (deploys enabled) or leaves it in the AWS account
 *    (remove it with cdk destroy / CloudFormation).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
// The panel has its own suite (deploy-pipeline-panel): here it is mounted, and finishes on a click.
jest.mock('@/components/pipeline/DeployPipelinePanel', () => ({
  __esModule: true,
  DeployPipelinePanel: ({ pipelineId, onDeployed }: { pipelineId: string; onDeployed?: () => void }) => (
    <div data-testid="deploy-panel">
      deploy-panel:{pipelineId}
      <button type="button" onClick={() => onDeployed?.()}>finish deploy</button>
    </div>
  ),
}));

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines/[id]', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const api = {
  getPipelineById: jest.fn<AnyFn>(),
  getExecutionCount: jest.fn<AnyFn>(),
  getOrganizationMembers: jest.fn<AnyFn>(),
  listPipelineDeployments: jest.fn<AnyFn>(),
  listPipelineExecutions: jest.fn<AnyFn>(),
  getPipelineSecurity: jest.fn<AnyFn>(),
  getPipelineRunnerLink: jest.fn<AnyFn>(),
  getPipelineRunners: jest.fn<AnyFn>(),
  deletePipeline: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const pipeline = {
  id: 'p1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'acme-web',
  props: {}, visibility: 'org', isActive: true, isDefault: false, createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
};
const NOT_DEPLOYED = { registered: false, lastDeployed: null, stackName: null, region: null, hasEvents: false };
const DEPLOYED = { registered: true, lastDeployed: '2026-11-09T00:00:00Z', stackName: 'web-stack', region: 'us-east-1', hasEvents: true };
const link = { pipelineId: 'p1', status: 'linked', runner: { id: 'r1', label: 'Production', health: 'healthy', lastDeliveryAt: null, ownerOrgName: null, isOwn: true, capabilities: [] as string[] }, checkedAt: null, detail: null, deliveriesPaused: false };
const runnersDto = (capabilities: string[]) => ({
  success: true,
  data: {
    available: true, unavailableReason: null, platformEgressIps: null, signingKey: null, inherited: [],
    own: [{ id: 'r1', orgId: 'org-1', label: 'Production', functionUrl: null, shareWithTeams: false, version: '1', regions: ['us-east-1'], health: 'healthy', status: 'active', lastDeliveryAt: null, createdAt: '2026-01-01T00:00:00Z', updateRequired: false, jwksUrl: 'x', pipelineCount: 1, capabilities, shareDeploysWithTeams: false, pipelinePrefixes: ['*'] }],
  },
});

let canAll = true;
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  canAll = true;
  mockRouter.query = { id: 'p1' };
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => canAll });
  api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: NOT_DEPLOYED } });
  api.getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [] } });
  api.getOrganizationMembers.mockResolvedValue({ success: true, data: { members: [], pagination: { hasMore: false } } });
  api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [], pagination: { hasMore: false } } });
  api.listPipelineExecutions.mockResolvedValue({ success: true, data: { executions: [] } });
  api.getPipelineSecurity.mockResolvedValue({ success: true, data: null });
  api.getPipelineRunnerLink.mockResolvedValue({ success: true, data: link });
  api.getPipelineRunners.mockResolvedValue(runnersDto([]));
  api.deletePipeline.mockResolvedValue({ success: true });
});

describe('deploying a never-deployed pipeline from its page', () => {
  it('shows the deploy panel under the banner, which keeps the CLI command', async () => {
    render(<PipelineDetailPage />);
    expect(await screen.findByTestId('deploy-panel')).toHaveTextContent('deploy-panel:p1');
    expect(screen.getByText(/Not deployed yet/).closest('div')).toHaveTextContent('pipeline-manager pipeline deploy --id p1');
  });

  it('a finished deploy reloads the pipeline', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'finish deploy' }));
    await waitFor(() => expect(api.getPipelineById.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('no panel for a viewer who cannot edit the pipeline', async () => {
    canAll = false;
    mockAuthGuard({ user: { id: 'u2', organizationId: 'org-1' }, can: (p: string) => p === 'pipelines:read' });
    render(<PipelineDetailPage />);
    await screen.findByText(/Not deployed yet/);
    expect(screen.queryByTestId('deploy-panel')).not.toBeInTheDocument();
  });

  it('no panel once deployed, nor for a deployed-but-unregistered pipeline', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: DEPLOYED } });
    const first = render(<PipelineDetailPage />);
    await waitFor(() => expect(api.getPipelineById).toHaveBeenCalled());
    await screen.findAllByText('acme-web');
    expect(screen.queryByTestId('deploy-panel')).not.toBeInTheDocument();
    first.unmount();
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { ...NOT_DEPLOYED, hasEvents: true } } });
    render(<PipelineDetailPage />);
    await screen.findByText(/Deployed but not registered/);
    expect(screen.queryByTestId('deploy-panel')).not.toBeInTheDocument();
  });
});

describe('deleting a deployed pipeline says what happens to its stack', () => {
  async function openDelete() {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: DEPLOYED } });
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    return screen.findByRole('dialog');
  }

  it('its runner cannot undeploy: the stack stays — remove it with cdk destroy or CloudFormation', async () => {
    const dialog = await openDelete();
    const note = await within(dialog).findByTestId('pipeline-stack-notice');
    await waitFor(() => expect(note).toHaveTextContent(/Production cannot remove it/));
    expect(note).toHaveTextContent(/stays in your AWS account/);
    expect(note).toHaveTextContent(/cdk destroy/);
    expect(note).not.toHaveTextContent(/If its runner/);
  });

  it('its runner has deploys enabled: purging it later removes the stack through that runner (read from the link, for any viewer)', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p !== 'org_settings:write' });
    api.getPipelineRunnerLink.mockResolvedValue({ success: true, data: { ...link, runner: { ...link.runner, capabilities: ['deploy:1'] } } });
    const dialog = await openDelete();
    const note = await within(dialog).findByTestId('pipeline-stack-notice');
    await waitFor(() => expect(note).toHaveTextContent(/Purging it from Recently deleted asks Production to delete the stack/));
    expect(note).not.toHaveTextContent(/otherwise/);
    expect(api.getPipelineRunners).not.toHaveBeenCalled();
  });

  it('no runner linked: purging leaves the stack in the account', async () => {
    api.getPipelineRunnerLink.mockResolvedValue({ success: true, data: { ...link, status: 'unlinked', runner: null } });
    const dialog = await openDelete();
    const note = await within(dialog).findByTestId('pipeline-stack-notice');
    await waitFor(() => expect(note).toHaveTextContent(/No pipeline runner is linked to it/));
    expect(note).toHaveTextContent(/stays in your AWS account/);
  });

  it('the link could not be read: both outcomes, stated plainly', async () => {
    api.getPipelineRunnerLink.mockRejectedValue(new Error('down'));
    const dialog = await openDelete();
    const note = await within(dialog).findByTestId('pipeline-stack-notice');
    expect(note).toHaveTextContent(/If its runner has deploys enabled/);
    expect(note).toHaveTextContent(/stays in your AWS account/);
  });

  it('a never-deployed pipeline has no stack to warn about', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('pipeline-stack-notice')).not.toBeInTheDocument();
  });
});
