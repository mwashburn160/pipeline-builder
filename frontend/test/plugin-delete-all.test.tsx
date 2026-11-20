// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Delete plugin (all versions)": the dialog shows the server's preview BEFORE
 * anything is deleted (what goes, what is skipped and why, what in-flight work
 * is cancelled), offers the listing request and the root-org notice, and sends
 * the step-up token. The deleted view restores / purges one batch by its id.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { DeletePluginDialog, pluginByNameError } from '../src/components/plugin/DeletePluginDialog';
import { DeletedPluginBatches, groupDeletedBatches } from '../src/components/plugin/DeletedPluginBatches';
import { PluginDetailModal } from '../src/components/plugin/PluginDetailModal';
import { ApiError } from '../src/lib/api/errors';
import { pageToast } from './helpers/pageMocks';

const getPluginDeletePreview = jest.fn<AnyFn>();
const deletePluginByName = jest.fn<AnyFn>();
const listDeletedPlugins = jest.fn<AnyFn>();
const restorePluginByName = jest.fn<AnyFn>();
const purgePluginByName = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getPluginDeletePreview: (...a: unknown[]) => getPluginDeletePreview(...a),
    deletePluginByName: (...a: unknown[]) => deletePluginByName(...a),
    listDeletedPlugins: (...a: unknown[]) => listDeletedPlugins(...a),
    restorePluginByName: (...a: unknown[]) => restorePluginByName(...a),
    purgePluginByName: (...a: unknown[]) => purgePluginByName(...a),
    listVulnWaivers: () => Promise.resolve({ success: true, data: { waivers: [] } }),
  },
}));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button onClick={() => onConfirmed('stepup-token')}>confirm-step-up</button>
  ),
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const PREVIEW = {
  name: 'tf-plan',
  inheritedFromRoot: false,
  listing: null,
  deletable: [{ id: 'v1', version: '1.0.0', sourceBytes: 2048 }, { id: 'v2', version: '1.1.0', sourceBytes: 2048 }],
  skipped: [
    { id: 'v3', version: '1.2.0', reason: 'in_use', pipelines: [{ id: 'pl1', name: 'checkout-api' }] },
    { id: 'v4', version: '1.3.0', reason: 'frozen' },
  ],
  inFlight: { builds: 1, remediations: 2 },
};

beforeEach(() => {
  jest.clearAllMocks();
  getPluginDeletePreview.mockResolvedValue({ success: true, data: PREVIEW });
  deletePluginByName.mockResolvedValue({ success: true, data: { batchId: 'b1', deleted: [{ id: 'v1', version: '1.0.0' }, { id: 'v2', version: '1.1.0' }], skipped: PREVIEW.skipped } });
});

describe('DeletePluginDialog', () => {
  it('shows the preview first: what is deleted, skipped (with reasons and pipelines) and cancelled', async () => {
    render(<DeletePluginDialog name="tf-plan" onClose={() => {}} />);
    expect(await screen.findByTestId('delete-plugin-summary')).toHaveTextContent('2 versions will be deleted (1.0.0, 1.1.0), with 4.0 KB of kept source');
    expect(screen.getByText('Used by pipelines')).toBeInTheDocument();
    expect(screen.getByText('Frozen by a publish request')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'checkout-api' })).toHaveAttribute('href', '/dashboard/pipelines/pl1');
    expect(screen.getByText(/1 build and 2 security remediations of this plugin will be cancelled/)).toBeInTheDocument();
    expect(deletePluginByName).not.toHaveBeenCalled();
  });

  it('deletes with the step-up token and reports deleted and skipped', async () => {
    const onDeleted = jest.fn();
    render(<DeletePluginDialog name="tf-plan" onClose={() => {}} onDeleted={onDeleted} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2 versions' }));
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(deletePluginByName).toHaveBeenCalledWith('tf-plan', { force: false, stepUpToken: 'stepup-token' }));
    expect(await screen.findByTestId('delete-plugin-result')).toHaveTextContent('Deleted 2 versions: 1.0.0, 1.1.0');
    expect(onDeleted).toHaveBeenCalled();
  });

  it('offers the listing request and the force option for listed versions', async () => {
    getPluginDeletePreview.mockResolvedValue({ success: true, data: {
      ...PREVIEW, listing: { id: 'L1', publisher: 'acme' }, skipped: [{ id: 'v5', version: '2.0.0', reason: 'listed' }],
    } });
    render(<DeletePluginDialog name="tf-plan" onClose={() => {}} />);
    expect(await screen.findByRole('link', { name: /request "unmaintained" or a yank/ }))
      .toHaveAttribute('href', '/dashboard/publisher?tab=listings&listingId=L1');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 3 versions' }));
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(deletePluginByName).toHaveBeenCalledWith('tf-plan', { force: true, stepUpToken: 'stepup-token' }));
  });

  it('says a root-org name has nothing to delete here', async () => {
    getPluginDeletePreview.mockResolvedValue({ success: true, data: { ...PREVIEW, inheritedFromRoot: true } });
    render(<DeletePluginDialog name="tf-plan" onClose={() => {}} />);
    expect(await screen.findByText('This plugin comes from your root organization')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete \d/ })).toBeNull();
  });

  it('words the rate limit, the managed name and the name lock', async () => {
    expect(pluginByNameError(new ApiError('x', 429, 'RATE_LIMITED'), 'f')).toMatch(/limit of 10 whole-plugin deletes/);
    expect(pluginByNameError(new ApiError('x', 409, 'PLUGIN_MANAGED_NAME_RESERVED'), 'f')).toMatch(/platform-managed toolchain/);
    expect(pluginByNameError(new ApiError('x', 409, 'PLUGIN_NAME_LOCKED'), 'f')).toMatch(/still running/);
    deletePluginByName.mockRejectedValue(new ApiError('x', 409, 'PLUGIN_MANAGED_NAME_RESERVED'));
    render(<DeletePluginDialog name="tf-plan" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2 versions' }));
    fireEvent.click(screen.getByText('confirm-step-up'));
    expect(await screen.findByText(/platform-managed toolchain/)).toBeInTheDocument();
  });
});

describe('deleted view batches', () => {
  const ROWS = [
    { id: 'v1', name: 'tf-plan', version: '1.0.0', deleteBatchId: 'b1', deletedAt: '2026-11-19T10:00:00Z' },
    { id: 'v2', name: 'tf-plan', version: '1.1.0', deleteBatchId: 'b1', deletedAt: '2026-11-19T10:00:01Z' },
    { id: 'v9', name: 'tf-plan', version: '0.9.0', deleteBatchId: null, deletedAt: '2026-11-01T10:00:00Z' },
  ];

  it('groups by name and batch, leaving single deletes out', () => {
    expect(groupDeletedBatches(ROWS)).toEqual([
      { name: 'tf-plan', batchId: 'b1', versions: ['1.0.0', '1.1.0'], deletedAt: '2026-11-19T10:00:01Z' },
    ]);
  });

  it('restores and purges one batch with its id and the step-up token', async () => {
    listDeletedPlugins.mockResolvedValue({ success: true, data: { plugins: ROWS } });
    restorePluginByName.mockResolvedValue({ success: true, data: { batchId: 'b1', done: [{ id: 'v1', version: '1.0.0' }], skipped: [{ id: 'v2', version: '1.1.0', reason: 'name_taken' }] } });
    purgePluginByName.mockResolvedValue({ success: true, data: { batchId: 'b1', done: [], skipped: [] } });
    render(<DeletedPluginBatches />);
    fireEvent.click(await screen.findByRole('button', { name: /Restore plugin/ }));
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(restorePluginByName).toHaveBeenCalledWith('tf-plan', 'b1', 'stepup-token'));
    await waitFor(() => expect(pageToast.success).toHaveBeenCalledWith('Restored 1 version of tf-plan; skipped 1.1.0 (name taken).'));
    fireEvent.click(await screen.findByRole('button', { name: /Purge plugin/ }));
    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(purgePluginByName).toHaveBeenCalledWith('tf-plan', 'b1', 'stepup-token'));
  });

  it('reads every deleted row, not only the server\'s default first page of 10', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, name: 'big', version: `1.0.${i}`, deleteBatchId: 'b9', deletedAt: '2026-11-19T10:00:00Z' }));
    // The server's paging: limit defaults to 10, offset to 0.
    listDeletedPlugins.mockImplementation(async (params?: Record<string, string>) => {
      const limit = Number(params?.limit ?? 10);
      const offset = Number(params?.offset ?? 0);
      return { success: true, data: { plugins: rows.slice(offset, offset + limit) } };
    });
    render(<DeletedPluginBatches />);
    expect(await screen.findByText(/12 versions/)).toBeTruthy();
  });

  it('renders nothing when no batch exists', async () => {
    listDeletedPlugins.mockResolvedValue({ success: true, data: { plugins: [ROWS[2]] } });
    const { container } = render(<DeletedPluginBatches />);
    await waitFor(() => expect(listDeletedPlugins).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PluginDetailModal delete-all action', () => {
  const PLUGIN = {
    id: 'v1', orgId: 'org-1', name: 'tf-plan', version: '1.0.0', pluginType: 'CodeBuildStep', computeType: 'SMALL',
    visibility: 'org', isActive: true, isDefault: true, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    imageSource: 'build',
  } as never;

  it('is offered only when the page passes it (plugins:write)', () => {
    const onDeleteAll = jest.fn();
    const { rerender } = render(<PluginDetailModal plugin={PLUGIN} showRegistryLink={false} onClose={() => {}} onDeleteAll={onDeleteAll} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete plugin (all versions)…' }));
    expect(onDeleteAll).toHaveBeenCalled();
    rerender(<PluginDetailModal plugin={PLUGIN} showRegistryLink={false} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /Delete plugin \(all versions\)/ })).toBeNull();
  });
});
