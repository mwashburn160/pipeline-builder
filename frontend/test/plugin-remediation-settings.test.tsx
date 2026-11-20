// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization → Plugin security → Security fixes: loads the org's
 * remediation settings, saves ONLY what changed (a cleared per-type override
 * is sent as null), shows a team what it inherits from the root, never offers
 * a team the root-only allowPipelineApply switch, stays editable while the
 * operator knob is off, and is read-only without org_settings:write.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

const getSettings = jest.fn<AnyFn>();
const updateSettings = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPluginRemediationSettings: (...a: unknown[]) => getSettings(...a),
    updatePluginRemediationSettings: (...a: unknown[]) => updateSettings(...a),
  },
}));

import { PluginRemediationSettings, remediationSettingsChanges } from '../src/components/settings/PluginRemediationSettings';

const SETTINGS = {
  mode: 'propose', libraryUpgradeLevel: 'minor', libraryUpgradeLevelByType: { npm: 'patch' }, libraryUpgradeLevelByPlugin: {},
  rollout: 'propose', allowPipelineApply: true,
} as const;
const view = (over: Record<string, unknown> = {}) => ({
  settings: { ...SETTINGS, libraryUpgradeLevelByType: { ...SETTINGS.libraryUpgradeLevelByType } },
  isTeam: false, root: null, enabled: true, severities: ['critical', 'high'], canEdit: true, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  getSettings.mockResolvedValue({ success: true, data: view() });
  updateSettings.mockImplementation(async () => ({ success: true, data: view() }));
});

const renderCard = (props: { canEdit?: boolean; readOnly?: boolean } = {}) =>
  render(<PluginRemediationSettings orgId="org-1" canEdit={props.canEdit ?? true} readOnly={props.readOnly ?? false} />);
const saveButton = () => screen.getByRole('button', { name: /save security fix settings/i });

describe('PluginRemediationSettings', () => {
  it('saves only the fields that changed', async () => {
    renderCard();
    await screen.findByTestId('plugin-remediation-settings');
    expect(saveButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Fix building'), { target: { value: 'apply' } });
    fireEvent.change(screen.getByLabelText('Pipeline rollout'), { target: { value: 'off' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({ mode: 'apply', rollout: 'off' });
    expect(toast.success).toHaveBeenCalled();
  });

  it('sends null to clear a per-type override and a level to add one', async () => {
    renderCard();
    await screen.findByTestId('plugin-remediation-settings');
    fireEvent.change(screen.getByLabelText('Upgrade level for npm package'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Upgrade level for Debian package'), { target: { value: 'patch' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith({ libraryUpgradeLevelByType: { npm: null, deb: 'patch' } });
  });

  it('shows the targeted severities and that KEV is always targeted', async () => {
    getSettings.mockResolvedValue({ success: true, data: view({ severities: ['critical'] }) });
    renderCard();
    expect((await screen.findByTestId('remediation-severities')).textContent).toBe('Critical');
    expect(screen.getByText(/KEV\) findings are always targeted/)).toBeTruthy();
  });

  it('shows a team the root rollout it follows and the root allowPipelineApply read-only', async () => {
    getSettings.mockResolvedValue({ success: true, data: view({
      isTeam: true, settings: { ...SETTINGS, rollout: 'inherit' }, root: { rollout: 'apply', allowPipelineApply: false },
    }) });
    renderCard();
    await screen.findByTestId('plugin-remediation-settings');
    expect(screen.getByText(/Following the root organization: Apply/)).toBeTruthy();
    expect(screen.getByRole('option', { name: /Follow the root organization/ })).toBeTruthy();
    expect(screen.getByTestId('root-allow-apply').textContent).toMatch(/no \(set by the root organization\)/);
    expect(screen.queryByText('Pipelines may choose Apply')).toBeNull();
  });

  it('offers a root org no inherit rollout, and never sends allowPipelineApply for a team', () => {
    renderCard();
    expect(remediationSettingsChanges(view().settings as never, { ...view().settings, allowPipelineApply: false } as never, true)).toBeNull();
    expect(remediationSettingsChanges(view().settings as never, { ...view().settings, allowPipelineApply: false } as never, false))
      .toEqual({ allowPipelineApply: false });
  });

  it('stays editable with the operator-off notice while the knob is off', async () => {
    getSettings.mockResolvedValue({ success: true, data: view({ enabled: false }) });
    renderCard();
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeTruthy();
    expect(screen.getByLabelText('Fix building')).not.toBeDisabled();
  });

  it('is read-only without org_settings:write', async () => {
    renderCard({ canEdit: false });
    await screen.findByTestId('plugin-remediation-settings');
    expect(screen.getByLabelText('Fix building')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save security fix settings/i })).toBeNull();
  });

  it('offers a retry when the settings cannot be read', async () => {
    getSettings.mockRejectedValue(new Error('boom'));
    renderCard();
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
