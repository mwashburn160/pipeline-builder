// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Create flows offer the full three-rung visibility ladder (private / org /
 * public) and preselect the entity's backend create default (`org` for
 * plugins). Regressions guarded: a two-value Private/Public picker that forced
 * `private`, a picker disabled outright for non-publishers (so they could never
 * reach `org`), and the wizard's edit prefill collapsing `org` → `private` so a
 * metadata save silently hid the plugin from the org.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CreatePluginModal from '../src/components/plugin/CreatePluginModal';
import WizardPluginTab from '../src/components/plugin/WizardPluginTab';

const listPlugins = jest.fn();
const getPluginById = jest.fn();
const updatePlugin = jest.fn();
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
jest.mock('../src/components/plugin/AIPluginBuilderTab', () => ({ __esModule: true, default: () => null }));

const ORG_LABEL = 'Org — everyone in your organization';

/** Option values of the visibility <select> currently showing `displayed`. */
function rungs(displayed: string): string[] {
  const select = screen.getByDisplayValue(displayed) as HTMLSelectElement;
  return within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
}

describe('create-flow visibility ladder', () => {
  beforeEach(() => jest.clearAllMocks());

  it('upload tab preselects org and offers all three rungs to a publisher', () => {
    render(<CreatePluginModal canPublish initialTab="upload" onClose={jest.fn()} onCreated={jest.fn()} />);
    expect(rungs(ORG_LABEL)).toEqual(['private', 'org', 'public']);
    expect(screen.getByDisplayValue(ORG_LABEL)).not.toBeDisabled();
  });

  it('a non-publisher still picks between private and org (only public is gated)', () => {
    render(<CreatePluginModal canPublish={false} initialTab="upload" onClose={jest.fn()} onCreated={jest.fn()} />);
    expect(rungs(ORG_LABEL)).toEqual(['private', 'org']);
    expect(screen.getByDisplayValue(ORG_LABEL)).not.toBeDisabled();
  });

  it('wizard create mode preselects org', () => {
    render(<WizardPluginTab canPublish={false} onCreated={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByDisplayValue(ORG_LABEL)).toBeInTheDocument();
  });

  it('wizard edit keeps an org plugin at org through prefill and save', async () => {
    const plugin = {
      id: 'p1', name: 'lint', version: '1.0.0', visibility: 'org', pluginType: 'CodeBuildStep',
      computeType: 'MEDIUM', commands: ['npm run lint'], installCommands: [], keywords: [],
      isActive: true, isDefault: false,
    };
    listPlugins.mockResolvedValue({ success: true, data: { plugins: [plugin] } });
    getPluginById.mockResolvedValue({ success: true, data: { plugin } });
    updatePlugin.mockResolvedValue({ success: true });

    render(<WizardPluginTab canPublish={false} onCreated={jest.fn()} onClose={jest.fn()} />);
    fireEvent.click(screen.getByText('Edit existing'));
    await waitFor(() => expect(screen.getByRole('option', { name: /lint v1\.0\.0/ })).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('Select a plugin…'), { target: { value: 'p1' } });

    // Prefill done once the row's commands land and Save re-enables.
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).not.toBeDisabled());
    expect(screen.getByDisplayValue(ORG_LABEL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(updatePlugin).toHaveBeenCalledWith('p1', expect.objectContaining({ visibility: 'org' })));
  });
});
