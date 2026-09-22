// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin editor edits only the descriptive catalog fields and operational
 * settings. `PUT /plugins/:id` refuses every execution-contract key (commands,
 * env, secrets, compute, name, version, …), so the editor must never send one,
 * and must send only what changed. A frozen version answers 409.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditPluginModal from '../src/components/plugin/EditPluginModal';
import type { PluginSummary } from '../src/lib/api/domains/plugins';
import { ApiError } from '../src/lib/api/errors';

jest.mock('@/hooks/useOrgHierarchy', () => ({
  __esModule: true,
  useOrgHierarchy: () => ({ activeOrg: { id: 'root-1' }, hasChildOrgs: false, isChildOrg: false }),
}));
jest.mock('@/hooks/useAuth', () => ({
  __esModule: true,
  useAuth: () => ({ user: { id: 'u1', role: 'admin' }, organizations: [{ id: 'root-1', name: 'Acme' }] }),
}));
jest.mock('@/hooks/usePlugins', () => ({ __esModule: true, clearPluginCache: jest.fn<AnyFn>() }));

const getPluginById = jest.fn<AnyFn>();
const updatePlugin = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPluginById: (...a: unknown[]) => getPluginById(...a),
    updatePlugin: (...a: unknown[]) => updatePlugin(...a),
    getOrganizationTeams: jest.fn<AnyFn>().mockResolvedValue({ success: true, data: { teams: [] } }),
  },
}));

const CONTRACT_KEYS = [
  'name', 'version', 'commands', 'installCommands', 'env', 'buildArgs', 'secrets', 'metadata', 'requiredMetadata',
  'requiredVars', 'metadataTypes', 'varsTypes', 'network', 'networkEgress', 'computeType', 'pluginType',
  'primaryOutputDirectory', 'smokeTest', 'timeout', 'failureBehavior', 'dockerfile', 'buildType',
];

const PLUGIN = {
  id: 'p1', name: 'scan', description: 'security scan', keywords: ['scan'], version: '1.0.0',
  pluginType: 'CodeBuildStep', computeType: 'SMALL', visibility: 'org', isActive: true, isDefault: false,
  createdBy: 'u1', createdAt: '2026-09-01T00:00:00Z', updatedBy: 'u1', updatedAt: '2026-09-01T00:00:00Z',
  orgId: 'root-1', failureBehavior: 'fail', category: 'security',
} as unknown as PluginSummary;

const FULL = {
  ...PLUGIN, metadata: { a: 1 }, env: { X: '1' }, buildArgs: {}, installCommands: ['npm ci'], commands: ['npm test'],
  secrets: [{ name: 'TOKEN', required: true }], timeout: 30, dockerfile: 'FROM node',
  displayName: 'Scan', summary: 'Scans things', license: 'MIT', homepageUrl: 'https://example.com',
  sourceUrl: null, documentationUrl: null, icon: { key: 'shield', badge: 'verified' }, changelog: null, readmeMd: '# Scan',
  metadataSources: { summary: 'readme', license: 'spec' },
};

beforeEach(() => {
  jest.clearAllMocks();
  getPluginById.mockResolvedValue({ success: true, data: { plugin: FULL } });
  updatePlugin.mockResolvedValue({ success: true, data: { plugin: FULL } });
});

function renderModal() {
  const onClose = jest.fn<AnyFn>();
  render(<EditPluginModal plugin={PLUGIN} canPublish onClose={onClose} onSaved={jest.fn<AnyFn>()} />);
  return { onClose };
}

const sent = () => updatePlugin.mock.calls[0][1] as Record<string, unknown>;

describe('EditPluginModal — catalog details only', () => {
  it('offers no execution-contract inputs and explains why', async () => {
    renderModal();
    await screen.findByLabelText('Summary');
    expect(screen.getByText(/execution contract/)).toBeInTheDocument();
    for (const label of [/^Commands/, /^Install commands/, /^Environment/, /^Secrets/, /^Timeout/, /^Failure behavior/]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    // Seeded from the full record, with its detected source.
    expect(screen.getByLabelText('Summary')).toHaveValue('Scans things');
    expect(screen.getByLabelText('README')).toHaveValue('# Scan');
    expect(screen.getByText(/Source: README/)).toBeInTheDocument();
  });

  it('sends only the changed descriptive fields — never a contract key', async () => {
    renderModal();
    fireEvent.change(await screen.findByLabelText('Summary'), { target: { value: 'Scans more things' } });
    fireEvent.change(screen.getByLabelText('Keywords'), { target: { value: 'scan, sast' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'quality' } });
    fireEvent.change(screen.getByLabelText('License'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Icon'), { target: { value: 'lock' } });
    fireEvent.change(screen.getByLabelText('README'), { target: { value: '# Scan v2' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    expect(sent()).toEqual({
      summary: 'Scans more things',
      keywords: ['scan', 'sast'],
      category: 'quality',
      license: null,
      icon: { key: 'lock', badge: 'verified' },
      readme: '# Scan v2',
    });
    for (const key of CONTRACT_KEYS) expect(sent()).not.toHaveProperty(key);
  });

  it('sends only operational changes when no catalog field changed', async () => {
    renderModal();
    fireEvent.click(await screen.findByLabelText('Default'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalled());
    expect(sent()).toEqual({ isDefault: true });
  });

  it('closes without a request when nothing changed', async () => {
    const { onClose } = renderModal();
    await screen.findByLabelText('Summary');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onClose).toHaveBeenCalled();
    expect(updatePlugin).not.toHaveBeenCalled();
  });

  it('blocks a non-https link client-side', async () => {
    renderModal();
    fireEvent.change(await screen.findByLabelText('Source URL'), { target: { value: 'http://github.com/acme/scan' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Source URL must use https/)).toBeInTheDocument();
    expect(updatePlugin).not.toHaveBeenCalled();
  });

  it('explains a 409 frozen version', async () => {
    updatePlugin.mockRejectedValue(new ApiError(
      'This plugin version is published to the ecosystem; its catalog details are frozen with it. Request a listing update instead.',
      409, 'PLUGIN_VERSION_FROZEN',
    ));
    renderModal();
    fireEvent.change(await screen.findByLabelText('Summary'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Catalog details are frozen for this version/)).toBeInTheDocument();
    expect(screen.getByText(/Request a listing update instead/)).toBeInTheDocument();
  });
});
