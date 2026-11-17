// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The wizard's EDIT mode may change only descriptive + operational fields:
 * `PUT /plugins/:id` refuses every execution-contract key, so those inputs are
 * read-only there (with the "upload a new version" note) and never sent.
 * Create mode keeps them editable.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WizardPluginTab from '../src/components/plugin/WizardPluginTab';
import { ApiError } from '../src/lib/api/errors';

const listPlugins = jest.fn<AnyFn>();
const getPluginById = jest.fn<AnyFn>();
const updatePlugin = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPlugins: (...a: unknown[]) => listPlugins(...a),
    getPluginById: (...a: unknown[]) => getPluginById(...a),
    updatePlugin: (...a: unknown[]) => updatePlugin(...a),
  },
}));
jest.mock('@/hooks/useBuildStatus', () => ({
  useBuildStatus: () => ({ status: 'idle', events: [], lastEvent: null }),
}));

const CONTRACT_KEYS = [
  'name', 'version', 'commands', 'installCommands', 'env', 'buildArgs', 'secrets', 'metadata', 'computeType',
  'pluginType', 'primaryOutputDirectory', 'timeout', 'failureBehavior', 'dockerfile', 'buildType',
];
const CONTRACT_LABELS = ['Plugin type', 'Compute type', 'Primary output directory', 'Install commands', 'Run commands', 'Environment'];

const plugin = {
  id: 'p1', name: 'lint', version: '1.0.0', visibility: 'org', pluginType: 'CodeBuildStep',
  computeType: 'MEDIUM', commands: ['npm run lint'], installCommands: ['npm ci'], env: { A: '1' }, keywords: ['lint'],
  description: 'Lints', isActive: true, isDefault: false, timeout: 10, failureBehavior: 'fail',
};

beforeEach(() => {
  jest.clearAllMocks();
  listPlugins.mockResolvedValue({ success: true, data: { plugins: [plugin] } });
  getPluginById.mockResolvedValue({ success: true, data: { plugin } });
  updatePlugin.mockResolvedValue({ success: true });
});

describe('WizardPluginTab — execution contract', () => {
  it('keeps contract inputs editable in create mode', () => {
    render(<WizardPluginTab canPublish={false} onCreated={jest.fn<AnyFn>()} onClose={jest.fn<AnyFn>()} />);
    for (const label of CONTRACT_LABELS) expect(screen.getByLabelText(label)).not.toBeDisabled();
    expect(screen.queryByText(/change only by uploading a new version/)).not.toBeInTheDocument();
  });

  it('makes contract inputs read-only in edit mode and sends only descriptive/operational fields', async () => {
    render(<WizardPluginTab canPublish={false} onCreated={jest.fn<AnyFn>()} onClose={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByText('Edit existing'));
    await waitFor(() => expect(screen.getByRole('option', { name: /lint v1\.0\.0/ })).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Select a plugin…'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).not.toBeDisabled());

    expect(screen.getByText(/change only by uploading a new version/)).toBeInTheDocument();
    for (const label of [...CONTRACT_LABELS, 'Timeout (minutes)', 'Failure behavior']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(screen.getByLabelText('Description')).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Lints harder' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    const sent = updatePlugin.mock.calls[0][1] as Record<string, unknown>;
    expect(sent).toMatchObject({ description: 'Lints harder', keywords: ['lint'], visibility: 'org' });
    for (const key of CONTRACT_KEYS) expect(sent).not.toHaveProperty(key);
  }, 20_000);

  it('sends the prefilled version as expectedUpdatedAt; a 412 offers Reload, which re-prefills the latest', async () => {
    getPluginById.mockResolvedValue({ success: true, data: { plugin: { ...plugin, updatedAt: '2026-09-01T00:00:00.000Z' } } });
    updatePlugin.mockRejectedValueOnce(new ApiError('The record was modified by someone else.', 412, 'PRECONDITION_FAILED'));
    render(<WizardPluginTab canPublish={false} onCreated={jest.fn<AnyFn>()} onClose={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByText('Edit existing'));
    await waitFor(() => expect(screen.getByRole('option', { name: /lint v1\.0\.0/ })).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Select a plugin…'), { target: { value: 'p1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My stale edit' } });
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledTimes(1));
    expect(updatePlugin.mock.calls[0][1]).toMatchObject({ expectedUpdatedAt: '2026-09-01T00:00:00.000Z' });
    expect(await screen.findByTestId('concurrency-conflict')).toHaveTextContent(/changed by someone else since you opened it/);

    getPluginById.mockResolvedValue({ success: true, data: { plugin: { ...plugin, description: 'Their edit', updatedAt: '2026-09-02T00:00:00.000Z' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('Their edit'));
    expect(screen.queryByTestId('concurrency-conflict')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledTimes(2));
    expect(updatePlugin.mock.calls[1][1]).toMatchObject({ description: 'Their edit', expectedUpdatedAt: '2026-09-02T00:00:00.000Z' });
  }, 20_000);
});
