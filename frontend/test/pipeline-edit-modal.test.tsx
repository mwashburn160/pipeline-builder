// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EditPipelineModal with the REAL builder underneath (only `@/lib/api` mocked):
 *  - round trip: the stored `props` are fetched by id, hydrated into the form,
 *    and saving WITHOUT edits sends them back unchanged — a lossy hydrate here
 *    silently rewrites a pipeline's config on every save;
 *  - an edit made in the form, the access/status controls, and the record's
 *    description/keywords all reach `PUT /pipelines/:id`;
 *  - the "Edit JSON" escape hatch applies hand-edited props back to the form,
 *    and refuses JSON that is not an object;
 *  - plugin warnings keep the modal open (the save is reported on close);
 *  - a failed fetch shows the error and never renders an empty builder that
 *    a save could push over the real config.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
let authUser: Record<string, unknown> = { id: 'u1', role: 'member', organizationId: 'org-1' };
jest.mock('@/hooks/useAuth', () => require('./helpers/pageMocks').authModule(() => ({ user: authUser })));
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

import EditPipelineModal from '@/components/pipeline/EditPipelineModal';

const PROPS = {
  project: 'web',
  organization: 'acme',
  pipelineName: 'acme-web-pipeline',
  synth: {
    source: { type: 'github', options: { repo: 'acme/web', branch: 'main' } },
    plugin: { name: 'cdk-synth' },
  },
  role: {
    type: 'oidc',
    options: {
      issuer: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      conditions: { 'token.actions.githubusercontent.com:sub': 'repo:acme/web:ref:refs/heads/main' },
    },
  },
  stages: [
    { stageName: 'Deploy', steps: [{ plugin: { name: 'cdk-deploy' }, preInstallCommands: ['npm ci'], env: { STAGE: 'prod' } }] },
  ],
};

const SUMMARY = {
  id: 'pl-1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline',
  visibility: 'org', isActive: true, isDefault: false, createdAt: '2026-11-01T00:00:00Z', createdBy: 'u1',
} as never;

const FULL = {
  ...(SUMMARY as object), props: PROPS, description: 'Web app', keywords: ['web', 'prod'],
  updatedAt: '2026-11-02T00:00:00Z', updatedBy: 'u2', ownerId: 'u1', ownerType: 'user',
};

function renderModal(over: { canPublish?: boolean } = {}) {
  const onClose = jest.fn<AnyFn>();
  const onSaved = jest.fn<AnyFn>();
  render(<EditPipelineModal pipeline={SUMMARY} canPublish={over.canPublish ?? true} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}
const next = () => fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
async function toLastStep() {
  next();
  await screen.findByLabelText('Repository *');
  next();
  await screen.findByRole('button', { name: '+ Add Stage' });
}

beforeEach(() => {
  resetApiMock();
  authUser = { id: 'u1', role: 'member', organizationId: 'org-1' };
  apiFn('getPipelineById').mockResolvedValue({ success: true, data: { pipeline: FULL } });
  apiFn('updatePipeline').mockResolvedValue({ success: true, data: {} });
});

describe('EditPipelineModal — round trip', () => {
  it('saving without edits sends the stored props back unchanged', async () => {
    const { onSaved } = renderModal();
    expect(await screen.findByLabelText('Project *')).toHaveValue('web');
    expect(apiFn('getPipelineById')).toHaveBeenCalledWith('pl-1');
    // The record's own fields are hydrated alongside the props.
    expect(screen.getByLabelText('Description')).toHaveValue('Web app');
    expect(screen.getByLabelText('Keywords (comma-separated)')).toHaveValue('web, prod');
    expect(screen.getByText('u2')).toBeInTheDocument(); // updated-by in System information
    await toLastStep();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipeline')).toHaveBeenCalledTimes(1));
    const [id, body] = apiFn('updatePipeline').mock.calls[0] as [string, Record<string, any>];
    expect(id).toBe('pl-1');
    expect(body).toMatchObject({
      pipelineName: 'acme-web-pipeline', description: 'Web app', keywords: ['web', 'prod'],
      isActive: true, isDefault: false, visibility: 'org',
    });
    // A member may not reassign ownership: no owner fields on the wire.
    expect(body).not.toHaveProperty('ownerId');
    expect(body.props).toEqual(PROPS);
    expect(await screen.findByText('Pipeline updated successfully!')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('a form edit, the status toggles and visibility reach the update; an admin sends the owner', async () => {
    authUser = { id: 'u1', role: 'admin', organizationId: 'org-1' };
    renderModal();
    await screen.findByLabelText('Project *');
    fireEvent.change(screen.getByLabelText('Keywords (comma-separated)'), { target: { value: 'web, , api ' } });
    fireEvent.click(screen.getByLabelText('Active'));
    fireEvent.click(screen.getByLabelText('Default'));
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
    next();
    fireEvent.change(await screen.findByLabelText('Branch'), { target: { value: 'release' } });
    next();
    await screen.findByRole('button', { name: '+ Add Stage' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipeline')).toHaveBeenCalledTimes(1));
    const body = apiFn('updatePipeline').mock.calls[0][1] as Record<string, any>;
    expect(body).toMatchObject({ keywords: ['web', 'api'], isActive: false, isDefault: true, visibility: 'private', ownerId: 'u1', ownerType: 'user' });
    expect(body.props.synth.source.options.branch).toBe('release');
  });
});

describe('EditPipelineModal — Edit JSON', () => {
  it('applies hand-edited props back to the form, and refuses a non-object', async () => {
    renderModal();
    await screen.findByLabelText('Project *');
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    const textarea = await screen.findByDisplayValue(/"pipelineName": "acme-web-pipeline"/);
    expect(screen.getByRole('button', { name: 'Refresh JSON' })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: '[1, 2]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to form' }));
    expect(await screen.findByText(/JSON must be an object/)).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: JSON.stringify({ ...PROPS, project: 'api' }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to form' }));
    await waitFor(() => expect(screen.getByLabelText('Project *')).toHaveValue('api'));
    // Description is a record field, untouched by a props apply.
    expect(screen.getByLabelText('Description')).toHaveValue('Web app');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('button', { name: 'Apply to form' })).not.toBeInTheDocument();
  });
});

describe('EditPipelineModal — warnings and failures', () => {
  it('plugin warnings keep the modal open; closing then reports the save', async () => {
    apiFn('updatePipeline').mockResolvedValue({
      success: true,
      data: { pluginWarnings: [{ stage: 'Deploy', step: 'cdk-deploy', plugin: 'cdk-deploy', severity: 'high', message: 'CVE-1 in base image', code: 'PLUGIN_VULNERABLE' }] },
    });
    const { onSaved, onClose } = renderModal();
    await screen.findByLabelText('Project *');
    await toLastStep();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByTestId('save-plugin-warnings')).toHaveTextContent('Saved with 1 plugin warning.');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('a refused save shows the error and stays editable', async () => {
    apiFn('updatePipeline').mockRejectedValue(new Error('Compliance blocked the save'));
    const { onSaved } = renderModal();
    await screen.findByLabelText('Project *');
    await toLastStep();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/Compliance blocked the save/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('a failed fetch shows the error and no builder', async () => {
    apiFn('getPipelineById').mockResolvedValue({ success: false, message: 'Pipeline not found' });
    renderModal();
    expect(await screen.findByText(/Pipeline not found/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Project *')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit JSON' })).toBeDisabled();
  });

  it('Previous walks back a step; an invalid step blocks Next', async () => {
    renderModal();
    await screen.findByLabelText('Project *');
    fireEvent.change(screen.getByLabelText('Project *'), { target: { value: '' } });
    next();
    expect(screen.getByText('Project is required')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Project *'), { target: { value: 'web' } });
    next();
    await screen.findByLabelText('Repository *');
    fireEvent.click(screen.getByRole('button', { name: /Previous/ }));
    expect(await screen.findByLabelText('Project *')).toBeInTheDocument();
    await act(async () => {});
  });
});
