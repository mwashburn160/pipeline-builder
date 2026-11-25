// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pipeline detail page: what it shows and what its write controls do.
 *  - Overview: registration warning, deployment card + console link, owner /
 *    creator names resolved from the roster, description / keywords.
 *  - Runs: the stats card, a failed run's failure detail, and Cancel on an
 *    in-progress run (confirmed) → stopPipelineExecution(id, execId).
 *  - Run / Delete target THIS pipeline; a read-only viewer gets disabled controls.
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

const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/pipelines/[id]', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const api = {
  getPipelineById: jest.fn<AnyFn>(),
  getExecutionCount: jest.fn<AnyFn>(),
  getOrganizationMembers: jest.fn<AnyFn>(),
  listPipelineDeployments: jest.fn<AnyFn>(),
  listPipelineExecutions: jest.fn<AnyFn>(),
  getPipelineSecurity: jest.fn<AnyFn>(),
  triggerPipelineExecution: jest.fn<AnyFn>(),
  stopPipelineExecution: jest.fn<AnyFn>(),
  deletePipeline: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const pipeline = {
  id: 'p1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'web-pipeline',
  description: 'Ships the web app', keywords: ['web', 'prod'], props: {}, criticality: 'high',
  visibility: 'org', isActive: true, isDefault: true, ownerId: 'u1', ownerType: 'user',
  createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', updatedBy: 'u9', updatedAt: '2026-01-02T00:00:00Z',
};
const exec = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  execution_id: id, status, started_at: '2026-11-10T00:00:00Z', ended_at: null, duration_ms: 65_000, failing_stage: null, failing_action: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.query = { id: 'p1' };
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: () => true });
  api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: false } } });
  api.getExecutionCount.mockResolvedValue({ success: true, data: { pipelines: [{ id: 'p1', total: 9, succeeded: 6, failed: 2, canceled: 1, last_execution: '2026-11-10T00:00:00Z' }] } });
  api.getOrganizationMembers.mockResolvedValue({ success: true, data: { members: [{ id: 'u1', username: 'alice' }], pagination: { hasMore: false } } });
  api.listPipelineDeployments.mockResolvedValue({ success: true, data: { registry: [{ pipelineId: 'p1', region: 'us-east-1', stackName: 'web-stack', lastDeployed: '2026-11-09T00:00:00Z' }], pagination: { hasMore: false } } });
  api.listPipelineExecutions.mockResolvedValue({ success: true, data: { executions: [
    exec('e-run', 'in-progress'),
    exec('e-fail', 'failed', { failing_stage: 'Deploy', failure: { code: 'BUILD_FAILED', message: 'tests failed', plugins: [{ name: 'jest', version: '1.0' }] } }),
  ] } });
  api.getPipelineSecurity.mockResolvedValue({ success: true, data: null });
  api.triggerPipelineExecution.mockResolvedValue({ success: true, data: { executionId: 'e-new' } });
  api.stopPipelineExecution.mockResolvedValue({ success: true });
  api.deletePipeline.mockResolvedValue({ success: true });
});

describe('pipeline detail overview', () => {
  it('shows the registration warning, deployment card and resolved names', async () => {
    render(<PipelineDetailPage />);
    expect(await screen.findByText(/Not deployed yet/)).toBeInTheDocument();
    expect(await screen.findByText('web-stack')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View stack in AWS/i })).toHaveAttribute('href', expect.stringContaining('us-east-1.console.aws.amazon.com'));
    expect(screen.getByText('Ships the web app')).toBeInTheDocument();
    expect(await screen.findAllByText('alice')).not.toHaveLength(0);
    expect(screen.getByText('u9')).toBeInTheDocument(); // unknown updater falls back to the id
    expect(screen.getByText('Default')).toBeInTheDocument();
  });
});

/**
 * The two unregistered states read differently. Right after Generate / create a
 * pipeline is simply not deployed — that is normal, and the page says how to
 * deploy it. A pipeline that has reported before but has no registration was
 * deployed; it registers itself on its next pipeline event, or by hand.
 */
describe('pipeline detail registration banner', () => {
  it('never deployed (no registration, no events): says how to deploy, and what Run does not do', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: false, hasEvents: false } } });
    render(<PipelineDetailPage />);
    const banner = (await screen.findByText(/Not deployed yet/)).closest('[role="alert"], div') as HTMLElement;
    expect(banner).toHaveTextContent('pipeline-manager pipeline deploy --id p1');
    expect(banner).toHaveTextContent(/Run pipeline only starts a pipeline that is already deployed/);
    expect(banner).toHaveTextContent(/registers itself on its first pipeline event/);
    expect(screen.queryByText(/Deployed but not registered/)).not.toBeInTheDocument();
  });

  it('deployed but not registered (it has reported before): registers itself, or by hand from Deployments', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: false, hasEvents: true } } });
    render(<PipelineDetailPage />);
    expect(await screen.findByText(/Deployed but not registered/)).toBeInTheDocument();
    expect(screen.getByText(/registers itself on its next pipeline event/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Register deployment/ })).toHaveAttribute('href', '/dashboard/deployments?register=p1');
    expect(screen.queryByText(/Not deployed yet/)).not.toBeInTheDocument();
  });

  it('shows neither once registered', async () => {
    api.getPipelineById.mockResolvedValue({ success: true, data: { pipeline, registration: { registered: true, hasEvents: true, lastDeployed: null, stackName: null, region: null } } });
    render(<PipelineDetailPage />);
    expect(await screen.findByText('Ships the web app')).toBeInTheDocument();
    expect(screen.queryByText(/Not deployed yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Deployed but not registered/)).not.toBeInTheDocument();
  });
});

describe('pipeline detail runs + actions', () => {
  it('shows stats and a failed run\'s failure detail', async () => {
    mockRouter.query = { id: 'p1', tab: 'runs' };
    render(<PipelineDetailPage />);
    expect(await screen.findByText('Total executions')).toBeInTheDocument();
    const failure = await screen.findByTestId('execution-failure-e-fail');
    expect(failure).toHaveTextContent('BUILD_FAILED');
    expect(failure).toHaveTextContent('tests failed');
  });

  it('Cancel on an in-progress run confirms, then stops THAT execution of THIS pipeline', async () => {
    mockRouter.query = { id: 'p1', tab: 'runs' };
    render(<PipelineDetailPage />);
    await screen.findByTestId('execution-failure-e-fail');
    const cancelButtons = screen.getAllByRole('button', { name: /^Cancel$/ });
    fireEvent.click(cancelButtons[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Stop|Cancel execution/ }));
    await waitFor(() => expect(api.stopPipelineExecution).toHaveBeenCalledWith('p1', 'e-run', expect.anything()));
  });

  it('Re-run triggers this pipeline', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run|Run pipeline/ }));
    await waitFor(() => expect(api.triggerPipelineExecution).toHaveBeenCalledWith('p1'));
  });

  it('Delete confirms, deletes this pipeline and returns to the list', async () => {
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(api.deletePipeline).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/dashboard/pipelines'));
  });

  it('a refused trigger shows the server message', async () => {
    api.triggerPipelineExecution.mockResolvedValue({ success: false, message: 'Pipeline not deployed' });
    render(<PipelineDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-run|Run pipeline/ }));
    expect(await screen.findByText(/Pipeline not deployed/)).toBeInTheDocument();
  });

  it('a read-only viewer gets disabled write controls', async () => {
    mockAuthGuard({ user: { id: 'u2', organizationId: 'org-1' }, can: (p: string) => p === 'pipelines:read' });
    render(<PipelineDetailPage />);
    expect(await screen.findByRole('button', { name: /Delete/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: /Edit/ })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('pipeline detail — Save as template', () => {
  it('is gated on templates:write (the template route\'s permission), not pipelines:write', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p !== 'templates:write' });
    const { unmount } = render(<PipelineDetailPage />);
    const locked = await screen.findByRole('button', { name: /Save as template/ });
    expect(locked).toBeDisabled();
    expect(locked).toHaveAttribute('title', 'Requires templates:write');
    unmount();

    // A template author without pipelines:write may still save one.
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1' }, can: (p: string) => p !== 'pipelines:write' });
    render(<PipelineDetailPage />);
    expect(await screen.findByRole('button', { name: /Save as template/ })).toBeEnabled();
  });
});

describe('pipeline detail — Recent runs card', () => {
  it('says the totals failed to load (with a retry) rather than "No recorded runs yet"', async () => {
    mockRouter.query = { id: 'p1', tab: 'runs' };
    api.getExecutionCount.mockRejectedValue(new Error('reporting down'));
    render(<PipelineDetailPage />);
    expect(await screen.findByText('Run totals could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No recorded runs yet.')).not.toBeInTheDocument();
  });

  it('shows a loading line while the totals are in flight', async () => {
    mockRouter.query = { id: 'p1', tab: 'runs' };
    api.getExecutionCount.mockImplementation(() => new Promise(() => {}));
    render(<PipelineDetailPage />);
    expect(await screen.findByText(/Loading runs/)).toBeInTheDocument();
    expect(screen.queryByText('No recorded runs yet.')).not.toBeInTheDocument();
  });
});
