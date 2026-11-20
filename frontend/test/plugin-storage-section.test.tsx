// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin page's Storage section: kept source and image bytes per version,
 * the source-less (prebuilt image) state, and what a purge would free. The
 * registry figures are optional; a failed read still shows the source bytes.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() })));
import { PluginStorageSection, versionStorageRows } from '../src/components/plugin/PluginStorageSection';

const listPlugins = jest.fn<AnyFn>();
const getStorageReclaim = jest.fn<AnyFn>();
const getPluginTidyPreview = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listPlugins: (...a: unknown[]) => listPlugins(...a),
    getStorageReclaim: (...a: unknown[]) => getStorageReclaim(...a),
    getPluginTidyPreview: (...a: unknown[]) => getPluginTidyPreview(...a),
  },
}));

const VERSIONS = [
  { id: 'v1', name: 'tf-plan', version: '1.0.0', sourceKind: 'zip', sourceSizeBytes: 1024 },
  { id: 'v2', name: 'tf-plan', version: '1.1.0', sourceKind: 'none', sourceSizeBytes: null },
  // A fuzzy name match from the list route: not this plugin.
  { id: 'x', name: 'tf-plan-extra', version: '9.0.0', sourceKind: 'zip', sourceSizeBytes: 999 },
];
const PLAN = {
  orgId: 'org-1', bytes: 0, reclaimableBytes: 0, incomplete: false, computedAt: 0, usedLabel: '', reclaimableLabel: '',
  candidates: [{ repo: 'r', tag: 't', pluginName: 'tf-plan', version: '1.1.0', totalBytes: 9999, marginalBytes: 2048, marginalLabel: '2 KB', eligible: true, reason: null, blockedBy: [] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  listPlugins.mockResolvedValue({ success: true, data: { plugins: VERSIONS } });
  getStorageReclaim.mockResolvedValue({ success: true, data: PLAN });
  getPluginTidyPreview.mockResolvedValue({ success: true, data: null });
});

describe('PluginStorageSection', () => {
  it('joins source and image bytes per version of this name only', () => {
    expect(versionStorageRows('tf-plan', VERSIONS as never, PLAN as never)).toEqual([
      { id: 'v1', version: '1.0.0', sourceBytes: 1024, sourceless: false, imageBytes: null },
      { id: 'v2', version: '1.1.0', sourceBytes: null, sourceless: true, imageBytes: 2048 },
    ]);
  });

  it('shows bytes, the source-less state and what a purge frees', async () => {
    render(<PluginStorageSection name="tf-plan" canWrite />);
    expect(await screen.findByText('Prebuilt image, no kept source')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    expect(await screen.findByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-storage-freed')).toHaveTextContent('Purging every version would free about 3.0 KB.');
    expect(screen.queryByText('9.0.0')).toBeNull();
  });

  it('still shows source bytes when the registry cannot be read, and says the figure is partial', async () => {
    getStorageReclaim.mockRejectedValue(new Error('503'));
    render(<PluginStorageSection name="tf-plan" canWrite />);
    expect(await screen.findByText('1.0 KB')).toBeInTheDocument();
    expect(screen.getByTestId('plugin-storage-freed')).toHaveTextContent(/could not all be measured/);
  });

  it('offers Keep and Never tidy only to a caller who may write (a read-only session may not)', async () => {
    getPluginTidyPreview.mockResolvedValue({ success: true, data: {
      settings: { autoTidy: 'on', staleAfterDays: 90, neverTidy: [], lastDigestAt: null },
      report: { mode: 'on', versions: [{ pluginId: 'v1', name: 'tf-plan', version: '1.0.0', state: 'warned', lastUsedAt: null, staleAt: '2026-11-21T00:00:00.000Z', deactivateAt: '2026-11-28T00:00:00.000Z', bytes: 10 }] },
      canEdit: true, canKeep: true,
    } });
    const { unmount } = render(<PluginStorageSection name="tf-plan" canWrite={false} />);
    expect(await screen.findByTestId('plugin-tidy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Keep 1.0.0/ })).toBeNull();
    expect(screen.getByRole('switch')).toBeDisabled();
    unmount();
    render(<PluginStorageSection name="tf-plan" canWrite />);
    expect(await screen.findByRole('button', { name: /Keep 1.0.0/ })).toBeInTheDocument();
  });
});
