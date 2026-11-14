// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Templates gallery → "Use template": declared inputs are seeded from their
 * defaults, validated (required, numeric), coerced to their declared types,
 * rendered by the instantiate route and then created through the normal
 * pipeline-create path — whose refusal (compliance / quota) is shown verbatim.
 * Plus the per-rung edit/delete affordances.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
const mockRouter = { query: {} as Record<string, string>, pathname: '/dashboard/templates', isReady: true, replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() };
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => mockRouter));

const api = {
  listPipelineTemplates: jest.fn<AnyFn>(),
  instantiatePipelineTemplate: jest.fn<AnyFn>(),
  createPipeline: jest.fn<AnyFn>(),
  deletePipelineTemplate: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

import TemplatesPage from '../pages/dashboard/templates';

const template = (over: Record<string, unknown> = {}) => ({
  id: 't1', name: 'Node service', description: 'Golden path', visibility: 'org', createdBy: 'u1',
  inputs: [
    { name: 'repoUrl', label: 'Repository', type: 'string', required: true },
    { name: 'replicas', type: 'number', default: 2 },
    { name: 'canary', type: 'boolean' },
    { name: 'tier', type: 'string', options: ['small', 'large'], default: 'small' },
  ],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', organizationName: 'acme' }, can: () => true });
  api.listPipelineTemplates.mockResolvedValue({ success: true, data: { templates: [template(), template({ id: 't2', name: 'Someone else draft', visibility: 'private', createdBy: 'u9', inputs: [] })], pagination: { total: 2 } } });
  api.instantiatePipelineTemplate.mockResolvedValue({ success: true, data: { props: { project: 'svc' }, description: 'd', keywords: ['k'] } });
  api.createPipeline.mockResolvedValue({ success: true, data: { pipeline: { id: 'p-new' } } });
  api.deletePipelineTemplate.mockResolvedValue({ success: true });
});

async function openFirst() {
  render(<TemplatesPage />);
  await screen.findByText('Node service');
  fireEvent.click(screen.getAllByRole('button', { name: /Use template/ })[0]);
  return screen.findByRole('dialog');
}

describe('templates: Use template', () => {
  it('seeds defaults, coerces types, renders then creates, and opens the new pipeline', async () => {
    const dialog = await openFirst();
    expect(within(dialog).getByLabelText(/^replicas/)).toHaveValue(2);
    fireEvent.change(within(dialog).getByLabelText(/^Project/), { target: { value: ' svc ' } });
    fireEvent.change(within(dialog).getByLabelText(/^Repository/), { target: { value: 'https://github.com/acme/svc' } });
    fireEvent.click(within(dialog).getByLabelText(/^canary/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pipeline' }));
    await waitFor(() => expect(api.instantiatePipelineTemplate).toHaveBeenCalledWith('t1', {
      project: 'svc', organization: 'acme', pipelineName: undefined,
      inputs: { repoUrl: 'https://github.com/acme/svc', replicas: 2, canary: true, tier: 'small' },
    }));
    await waitFor(() => expect(api.createPipeline).toHaveBeenCalledWith(expect.objectContaining({ project: 'svc', visibility: 'org', props: { project: 'svc' }, keywords: ['k'] })));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/dashboard/pipelines/p-new'));
  });

  it('refuses a missing project and a missing required input; an emptied optional input is left out', async () => {
    const dialog = await openFirst();
    const create = within(dialog).getByRole('button', { name: 'Create pipeline' });
    fireEvent.click(create);
    expect(pageToast.error).toHaveBeenLastCalledWith('Project is required');
    fireEvent.change(within(dialog).getByLabelText(/^Project/), { target: { value: 'svc' } });
    fireEvent.click(create);
    expect(pageToast.error).toHaveBeenLastCalledWith('Input "Repository" is required');
    fireEvent.change(within(dialog).getByLabelText(/^Repository/), { target: { value: 'r' } });
    expect(api.instantiatePipelineTemplate).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/^replicas/), { target: { value: '' } });
    fireEvent.click(create);
    await waitFor(() => expect(api.instantiatePipelineTemplate).toHaveBeenCalledWith('t1', expect.objectContaining({
      inputs: { repoUrl: 'r', canary: false, tier: 'small' },
    })));
  });

  it('shows the render refusal, and the create refusal verbatim', async () => {
    api.instantiatePipelineTemplate.mockResolvedValueOnce({ success: false, message: 'Input tier invalid' });
    const dialog = await openFirst();
    fireEvent.change(within(dialog).getByLabelText(/^Project/), { target: { value: 'svc' } });
    fireEvent.change(within(dialog).getByLabelText(/^Repository/), { target: { value: 'r' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pipeline' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenLastCalledWith('Input tier invalid'));

    api.createPipeline.mockResolvedValueOnce({ success: false, message: 'Blocked by compliance rule X' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create pipeline' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenLastCalledWith('Blocked by compliance rule X'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('offers edit/delete only where the ladder allows, and delete confirms', async () => {
    render(<TemplatesPage />);
    await screen.findByText('Node service');
    expect(screen.queryByRole('button', { name: 'Delete template Someone else draft' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete template Node service' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(api.deletePipelineTemplate).toHaveBeenCalledWith('t1'));
  });
});
