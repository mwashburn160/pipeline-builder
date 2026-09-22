// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Version-lifecycle controls (plugin-ecosystem W0.4): the Deprecated / Yanked
 * badges, which actions a row offers, and the confirm dialog that calls
 * `POST /plugins/:id/deprecate` and `POST /plugins/:id/yank`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PluginLifecycleModal, lifecycleActionsFor } from '../src/components/plugin/PluginLifecycleModal';
import { PluginLifecycleBadges } from '../src/components/plugin/PluginLifecycleBadges';
import { PluginDetailModal } from '../src/components/plugin/PluginDetailModal';
import type { PluginSummary } from '../src/lib/api/domains/plugins';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const deprecatePlugin = jest.fn<AnyFn>();
const yankPlugin = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    deprecatePlugin: (...a: unknown[]) => deprecatePlugin(...a),
    yankPlugin: (...a: unknown[]) => yankPlugin(...a),
  },
}));

const PLUGIN = {
  id: 'p1', name: 'scan', version: '1.2.0', pluginType: 'CodeBuildStep', computeType: 'SMALL', visibility: 'org',
  isActive: true, isDefault: true, createdBy: 'u1', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  orgId: 'org-1', deprecatedAt: null, deprecationMessage: null, yankedAt: null, yankReason: null,
} as unknown as PluginSummary;

beforeEach(() => {
  jest.clearAllMocks();
  deprecatePlugin.mockResolvedValue({ success: true, data: { plugin: PLUGIN } });
  yankPlugin.mockResolvedValue({ success: true, data: { plugin: PLUGIN } });
});

function renderModal(action: 'deprecate' | 'undeprecate' | 'yank', plugin: PluginSummary = PLUGIN) {
  const onClose = jest.fn<AnyFn>();
  const onDone = jest.fn<AnyFn>();
  render(<PluginLifecycleModal plugin={plugin} action={action} onClose={onClose} onDone={onDone} />);
  return { onClose, onDone };
}

describe('lifecycleActionsFor', () => {
  it('offers deprecate + yank on a live version, clear + yank on a deprecated one, nothing on a yanked one', () => {
    expect(lifecycleActionsFor({ deprecatedAt: null, yankedAt: null })).toEqual(['deprecate', 'yank']);
    expect(lifecycleActionsFor({ deprecatedAt: '2026-09-01', yankedAt: null })).toEqual(['undeprecate', 'yank']);
    expect(lifecycleActionsFor({ deprecatedAt: '2026-09-01', yankedAt: '2026-09-02' })).toEqual([]);
  });
});

describe('PluginLifecycleBadges', () => {
  it('shows nothing for a live version', () => {
    const { container } = render(<PluginLifecycleBadges plugin={PLUGIN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows Deprecated with the message as its title', () => {
    render(<PluginLifecycleBadges plugin={{ ...PLUGIN, deprecatedAt: '2026-09-01', deprecationMessage: 'Use 2.x' }} />);
    expect(screen.getByText('Deprecated').closest('span[title]')).toHaveAttribute('title', 'Deprecated: Use 2.x');
  });

  it('Yanked wins over Deprecated and carries the reason', () => {
    render(<PluginLifecycleBadges plugin={{ ...PLUGIN, deprecatedAt: '2026-09-01', yankedAt: '2026-09-02', yankReason: 'leaks' }} />);
    expect(screen.queryByText('Deprecated')).not.toBeInTheDocument();
    expect(screen.getByText('Yanked').closest('span[title]')).toHaveAttribute('title', 'Yanked: leaks');
  });

  it('titles a bare badge when there is no message or reason', () => {
    render(<PluginLifecycleBadges plugin={{ ...PLUGIN, deprecatedAt: '2026-09-01' }} />);
    expect(screen.getByText('Deprecated').closest('span[title]')).toHaveAttribute('title', 'Deprecated');
  });
});

describe('PluginDetailModal lifecycle notice', () => {
  it('explains a yanked version with its reason', () => {
    render(<PluginDetailModal plugin={{ ...PLUGIN, yankedAt: '2026-09-02T00:00:00Z', yankReason: 'leaks tokens' }} showRegistryLink={false} onClose={() => {}} />);
    expect(screen.getByText(/an exact pin still does/)).toHaveTextContent('Reason: leaks tokens');
  });

  it('explains a deprecated version with its message', () => {
    render(<PluginDetailModal plugin={{ ...PLUGIN, deprecatedAt: '2026-09-02T00:00:00Z', deprecationMessage: 'Use 2.x' }} showRegistryLink={false} onClose={() => {}} />);
    expect(screen.getByText(/synth warns/)).toHaveTextContent('Use 2.x');
  });
});

describe('PluginLifecycleModal', () => {
  it('deprecates with the optional message and refreshes', async () => {
    const { onClose, onDone } = renderModal('deprecate');
    fireEvent.change(screen.getByLabelText(/message for users/i), { target: { value: '  Use 2.x  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(deprecatePlugin).toHaveBeenCalledWith('p1', { deprecated: true, message: 'Use 2.x' });
    expect(onClose).toHaveBeenCalled();
    expect(pageToast.success).toHaveBeenCalledWith('Version deprecated');
  });

  it('deprecates without a message when none is given', async () => {
    const { onDone } = renderModal('deprecate');
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(deprecatePlugin).toHaveBeenCalledWith('p1', { deprecated: true });
  });

  it('clears a deprecation', async () => {
    const { onDone } = renderModal('undeprecate', { ...PLUGIN, deprecatedAt: '2026-09-01' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear deprecation' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(deprecatePlugin).toHaveBeenCalledWith('p1', { deprecated: false });
  });

  it('requires a reason to yank', async () => {
    renderModal('yank');
    fireEvent.click(screen.getByRole('button', { name: 'Yank' }));
    expect(await screen.findByText('A reason is required.')).toBeInTheDocument();
    expect(yankPlugin).not.toHaveBeenCalled();
  });

  it('yanks with the reason and names the promoted default', async () => {
    yankPlugin.mockResolvedValue({ success: true, data: { plugin: PLUGIN, promotedDefault: { id: 'p0', version: '1.1.0' } } });
    const { onDone } = renderModal('yank');
    expect(screen.getByText(/The next version becomes the default/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'leaks tokens' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yank' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(yankPlugin).toHaveBeenCalledWith('p1', 'leaks tokens');
    expect(pageToast.success).toHaveBeenCalledWith('Version yanked; scan@1.1.0 is now the default');
  });

  it('shows the server refusal (e.g. 409 for a listed version) and stays open', async () => {
    yankPlugin.mockRejectedValue(new Error('This plugin version is published to the ecosystem; request a yank from the ecosystem instead.'));
    const { onClose, onDone } = renderModal('yank', { ...PLUGIN, isDefault: false });
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yank' }));
    expect(await screen.findByText(/request a yank from the ecosystem/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surfaces a failed clear as an alert', async () => {
    deprecatePlugin.mockRejectedValue(new Error('nope'));
    renderModal('undeprecate', { ...PLUGIN, deprecatedAt: '2026-09-01' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear deprecation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
  });
});
