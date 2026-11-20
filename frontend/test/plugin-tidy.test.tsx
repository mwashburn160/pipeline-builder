// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Automatic plugin version tidying in the dashboard:
 *  - Settings → Organization → Plugin security → Automatic tidying: the mode,
 *    the days (min 30), the dry-run preview with each kept version's reason and
 *    the bytes freed, saving ONLY what changed, read-only without
 *    org_settings:write;
 *  - the plugin page: a "Stale" badge with the deactivation date, Keep per
 *    version and the never-tidy switch (plugins:write), and the bytes tidying frees;
 *  - the digest's Keep link banner.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

const api = {
  getPluginTidyPreview: jest.fn<AnyFn>(),
  updatePluginTidySettings: jest.fn<AnyFn>(),
  keepPluginVersion: jest.fn<AnyFn>(),
  setPluginNeverTidy: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { PluginTidySettings, tidySettingsChanges } from '../src/components/settings/PluginTidySettings';
import { PluginTidyControls, TidyKeepBanner } from '../src/components/plugin/PluginTidyControls';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const VERSIONS = [
  { pluginId: 'p-1', name: 'lint', version: '1.0.0', state: 'warned', lastUsedAt: null, staleAt: '2026-11-21T00:00:00.000Z', deactivateAt: '2026-11-28T00:00:00.000Z', retireAt: '2026-12-28T00:00:00.000Z', bytes: 2048 },
  { pluginId: 'p-2', name: 'lint', version: '0.9.0', state: 'deactivated', lastUsedAt: null, staleAt: '2026-10-01T00:00:00.000Z', deactivateAt: '2026-10-08T00:00:00.000Z', retireAt: '2026-11-07T00:00:00.000Z', bytes: 1024 },
  { pluginId: 'p-3', name: 'lint', version: '2.0.0', state: 'skipped', reason: 'latest', lastUsedAt: null, staleAt: '2026-10-01T00:00:00.000Z', bytes: 0 },
];
const view = (over: Record<string, unknown> = {}, report: Record<string, unknown> = {}) => ({
  settings: { autoTidy: 'on', staleAfterDays: 90, neverTidy: [], lastDigestAt: null },
  report: {
    orgId: 'org-1', generatedAt: '2026-11-20T00:00:00.000Z', dryRun: true, operatorEnabled: true, mode: 'on', staleAfterDays: 90, neverTidy: [],
    lastDigestAt: null, nextDigestAt: '2026-11-20T00:00:00.000Z', versions: VERSIONS,
    totals: { warn: 0, warnQueued: 0, warned: 1, deactivate: 0, deactivated: 1, retire: 0, skipped: 1, reactivate: 0, bytesFreed: 3072 },
    storage: { measured: true },
    ...report,
  },
  canEdit: true,
  canKeep: true,
  ...over,
});

beforeEach(() => { jest.clearAllMocks(); });

describe('Automatic tidying settings', () => {
  it('shows the mode, the days and the preview: what it acts on, why each kept version is kept, and the bytes freed', async () => {
    api.getPluginTidyPreview.mockReturnValue(ok(view()));
    render(<PluginTidySettings orgId="org-1" canEdit readOnly={false} />);
    expect(((await screen.findByLabelText('Automatic tidying mode')) as HTMLSelectElement).value).toBe('on');
    expect((screen.getByLabelText('Stale after days') as HTMLInputElement).value).toBe('90');
    fireEvent.click(screen.getByText(/^Preview:/));
    expect(screen.getByTestId('plugin-tidy-preview').textContent).toMatch(/frees about 3.0 KB/);
    expect(screen.getByText('Stale — deactivated on 2026-11-28')).toBeTruthy();
    expect(screen.getByText('Kept: Latest version')).toBeTruthy();
  });

  it('saves ONLY what changed, and refuses fewer than 30 days', async () => {
    api.getPluginTidyPreview.mockReturnValue(ok(view({ settings: { autoTidy: 'notify', staleAfterDays: 90, neverTidy: [], lastDigestAt: null } })));
    api.updatePluginTidySettings.mockReturnValue(ok({ settings: { autoTidy: 'on', staleAfterDays: 90, neverTidy: [], lastDigestAt: null } }));
    render(<PluginTidySettings orgId="org-1" canEdit readOnly={false} />);
    const save = await screen.findByRole('button', { name: 'Save tidying settings' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Stale after days'), { target: { value: '20' } });
    expect(screen.getByText('Enter 30 days or more.')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Stale after days'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Automatic tidying mode'), { target: { value: 'on' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.updatePluginTidySettings).toHaveBeenCalledWith({ autoTidy: 'on' }));
    expect(tidySettingsChanges({ autoTidy: 'on', staleAfterDays: 90 }, { autoTidy: 'on', staleAfterDays: 90 })).toBeNull();
  });

  it('is read-only without org_settings:write, and says when the operator turned the job off', async () => {
    api.getPluginTidyPreview.mockReturnValue(ok(view({ canEdit: false }, { operatorEnabled: false })));
    render(<PluginTidySettings orgId="org-1" canEdit={false} readOnly={false} />);
    expect(((await screen.findByLabelText('Automatic tidying mode')) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save tidying settings' })).toBeNull();
    expect(screen.getByText(/turned off on this instance by the operator/)).toBeTruthy();
  });
});

describe('the plugin page', () => {
  it('badges each stale version with its date, keeps one, and says what tidying frees', async () => {
    api.keepPluginVersion.mockReturnValue(ok({ plugin: { id: 'p-1', name: 'lint', version: '1.0.0' } }));
    const onChanged = jest.fn<AnyFn>();
    render(<PluginTidyControls name="lint" view={view() as never} onChanged={onChanged} />);
    expect(screen.getByText('Stale — deactivated on 2026-11-28')).toBeTruthy();
    expect(screen.getByText('Stale — deactivated, deleted on 2026-11-07')).toBeTruthy();
    expect(screen.getByTestId('plugin-tidy-freed').textContent).toMatch(/free about 3.0 KB from 2 stale versions/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep 1.0.0' }));
    await waitFor(() => expect(api.keepPluginVersion).toHaveBeenCalledWith('p-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('switches the plugin to never tidy', async () => {
    api.setPluginNeverTidy.mockReturnValue(ok({ name: 'lint', neverTidy: true, settings: {} }));
    render(<PluginTidyControls name="lint" view={view() as never} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(api.setPluginNeverTidy).toHaveBeenCalledWith('lint', true));
  });

  it('offers no Keep or never-tidy without plugins:write, and nothing while tidying is off', () => {
    const { unmount } = render(<PluginTidyControls name="lint" view={view({ canKeep: false }) as never} onChanged={() => {}} />);
    expect(screen.getByText('Stale — deactivated on 2026-11-28')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Keep/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    render(<PluginTidyControls name="lint" view={view({}, { mode: 'off' }) as never} onChanged={() => {}} />);
    expect(screen.queryByTestId('plugin-tidy')).toBeNull();
  });
});

describe('the digest\'s Keep link', () => {
  it('offers the Keep for the linked version to a plugins:write holder only', async () => {
    api.keepPluginVersion.mockReturnValue(ok({ plugin: { id: 'p-1', name: 'lint', version: '1.0.0' } }));
    const onDone = jest.fn<AnyFn>();
    const { unmount } = render(<TidyKeepBanner pluginId="p-1" canWrite={false} onDone={onDone} />);
    expect(screen.queryByTestId('tidy-keep-banner')).toBeNull();
    unmount();
    render(<TidyKeepBanner pluginId="p-1" canWrite onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep this version' }));
    await waitFor(() => expect(api.keepPluginVersion).toHaveBeenCalledWith('p-1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Kept lint@1.0.0: its clock restarted'));
    expect(onDone).toHaveBeenCalled();
  });
});
