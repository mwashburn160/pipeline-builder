// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Toolchain console's "Toolchain fixes" card (nightly toolchain fixes,
 * propose-only): each release candidate with the findings it clears and its
 * version diff (release, base image, sourceDigest, both digests; the tool
 * versions it keeps), Approve / Reject behind a step-up, the spec-patch
 * Export, and the operator-off state.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { ToolchainFixesCard } from '../src/components/toolchain/ToolchainFixesCard';
import type { ToolchainFixDto } from '../src/types/toolchain';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, details, onConfirmed, onClose }: { action: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void> | void; onClose: () => void }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <div>{details}</div>
      <button type="button" onClick={async () => { await onConfirmed('step-up-token'); onClose(); }}>Confirm identity</button>
    </div>
  ),
}));
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

const fns = {
  listToolchainFixes: jest.fn<AnyFn>(),
  approveToolchainFix: jest.fn<AnyFn>(),
  rejectToolchainFix: jest.fn<AnyFn>(),
  downloadToolchainFixExport: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (fns as Record<string, (...x: unknown[]) => unknown>)[k](...a) }),
}));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const D = (c: string) => `sha256:${c.repeat(64)}`;
const fix = (over: Partial<ToolchainFixDto> = {}): ToolchainFixDto => ({
  id: 'fix-1',
  stage: 'awaiting_approval',
  outcome: null,
  fromRelease: '1.1.31',
  toRelease: '1.1.32',
  targetedCount: 2,
  cleared: [
    { id: 'CVE-2026-1', purl: 'pkg:deb/debian/perl-base@5.36-1', packageName: 'perl-base', packageType: 'deb', fromVersion: '5.36-1', toVersion: null, method: 'rebuild', half: 'pipeline-bootstrap' },
    { id: 'CVE-2026-1', purl: 'pkg:deb/debian/perl-base@5.36-1', packageName: 'perl-base', packageType: 'deb', fromVersion: '5.36-1', toVersion: null, method: 'rebuild', half: 'cdk-synth' },
    { id: 'CVE-2026-2', purl: 'pkg:deb/debian/tar@1.34', packageName: 'tar', packageType: 'deb', fromVersion: '1.34', toVersion: null, method: 'rebuild', half: 'cdk-synth' },
  ],
  remaining: [],
  toolchain: { pipelineManager: '6.3.1', awsCdk: '2.1148.1', cdkAssets: '4.8.0', node: '26.13.1' },
  baseImage: { from: `node:26.13.1-slim@${D('a')}`, to: `node:26.13.1-slim@${D('e')}` },
  sourceDigest: { from: D('1'), to: D('2') },
  digests: { 'pipeline-bootstrap': { from: D('3'), to: D('b') }, 'cdk-synth': { from: D('4'), to: D('5') } },
  hasExport: true,
  publishing: null,
  error: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: '2026-11-20T03:00:00Z',
  finishedAt: null,
  ...over,
});
const list = (fixes: ToolchainFixDto[], over: Record<string, unknown> = {}) => ok({ fixes, enabled: true, mode: 'propose', ...over });

beforeEach(() => {
  jest.clearAllMocks();
  fns.listToolchainFixes.mockImplementation(() => list([fix()]));
  fns.approveToolchainFix.mockImplementation(() => ok(fix({ stage: 'done', outcome: 'cleared' })));
  fns.rejectToolchainFix.mockImplementation(() => ok(fix({ stage: 'failed', outcome: 'rejected' })));
  fns.downloadToolchainFixExport.mockImplementation(() => Promise.resolve({ blob: new Blob(['diff']), filename: 'toolchain-1.1.32-spec.diff' }));
});

const card = async (props: Partial<Parameters<typeof ToolchainFixesCard>[0]> = {}) => {
  render(<ToolchainFixesCard allowed canWrite onPublished={jest.fn<() => void>()} {...props} />);
  return screen.findByTestId('toolchain-fix-fix-1');
};

describe('Toolchain fixes card', () => {
  it('lists a candidate with the findings it clears and its version diff', async () => {
    const item = await card();
    expect(item).toHaveTextContent('1.1.31 → 1.1.32');
    // Each advisory once, whichever half it was in.
    expect(within(item).getAllByText('CVE-2026-1')).toHaveLength(1);
    expect(item).toHaveTextContent('CVE-2026-2');
    expect(item).toHaveTextContent('tar');
    // The tools it keeps, verified unchanged.
    expect(item).toHaveTextContent('pipeline-manager 6.3.1');
    expect(item).toHaveTextContent('aws-cdk 2.1148.1');
    expect(item).toHaveTextContent('cdk-assets 4.8.0');
    expect(item).toHaveTextContent('node 26.13.1');
    // What moves: base image, sourceDigest, both image digests (short).
    expect(item).toHaveTextContent(`node:26.13.1-slim@${D('a').slice(0, 19)}`);
    expect(item).toHaveTextContent(D('e').slice(7, 19));
    expect(item).toHaveTextContent(D('2').slice(7, 19));
    expect(item).toHaveTextContent(D('b').slice(7, 19));
    expect(item).toHaveTextContent(D('5').slice(7, 19));
  });

  it('Approve steps up, publishes, and says orgs move only through their own default', async () => {
    const onPublished = jest.fn<() => void>();
    await card({ onPublished });
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1.1.32' }));
    const dialog = screen.getByRole('dialog', { name: 'step-up' });
    expect(dialog).toHaveTextContent('Publish toolchain release 1.1.32');
    expect(dialog).toHaveTextContent(/no org is moved/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm identity' }));
    await waitFor(() => expect(fns.approveToolchainFix).toHaveBeenCalledWith('fix-1', {}, 'step-up-token'));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    await waitFor(() => expect(fns.listToolchainFixes).toHaveBeenCalledTimes(2));
  });

  it('Reject steps up and rejects', async () => {
    await card();
    fireEvent.click(screen.getByRole('button', { name: 'Reject 1.1.32' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'step-up' })).getByRole('button', { name: 'Confirm identity' }));
    await waitFor(() => expect(fns.rejectToolchainFix).toHaveBeenCalledWith('fix-1', {}, 'step-up-token'));
    expect(fns.approveToolchainFix).not.toHaveBeenCalled();
  });

  it('Export downloads the spec patch', async () => {
    await card();
    fireEvent.click(screen.getByRole('button', { name: 'Export spec patch 1.1.32' }));
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), 'toolchain-1.1.32-spec.diff'));
  });

  it('a decided candidate has no decision buttons; a refused one shows why', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([
      fix({ stage: 'done', outcome: 'cleared', decidedBy: 'op-1', decidedAt: '2026-11-20T05:00:00Z' }),
      fix({ id: 'fix-2', stage: 'needs_owner', outcome: 'owner_request', toRelease: null, error: 'TOOL_VERSION_CHANGED', digests: null, toolchain: null, cleared: [], hasExport: false }),
    ]));
    await card();
    expect(screen.queryByRole('button', { name: 'Approve 1.1.32' })).not.toBeInTheDocument();
    expect(screen.getByTestId('toolchain-fix-fix-2')).toHaveTextContent(/would change a tool version/i);
  });

  it('an interrupted publish shows its progress, offers Resume publish (step-up) and no Reject', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([fix({
      decidedBy: 'op-1', decidedAt: '2026-11-20T05:00:00Z',
      publishing: { approvedBy: 'op-1', approvedAt: '2026-11-20T05:00:00Z', steps: { bootstrap: 'p-1', cdkSynth: null, inputs: false, notice: false } },
    })]));
    const item = await card();
    expect(item).toHaveTextContent(/publishing was interrupted/i);
    expect(item).toHaveTextContent('pipeline-bootstrap stored');
    expect(screen.queryByRole('button', { name: 'Reject 1.1.32' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume publish 1.1.32' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'step-up' })).getByRole('button', { name: 'Confirm identity' }));
    await waitFor(() => expect(fns.approveToolchainFix).toHaveBeenCalledWith('fix-1', {}, 'step-up-token'));
  });

  it('a read-only session sees the decisions locked', async () => {
    await card({ canWrite: false });
    expect(screen.getByRole('button', { name: 'Approve 1.1.32' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Reject 1.1.32' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('operator off: says so (PLUGIN_REMEDIATION_TOOLCHAINS=off)', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([], { mode: 'off' }));
    render(<ToolchainFixesCard allowed canWrite onPublished={jest.fn<() => void>()} />);
    expect(await screen.findByTestId('toolchain-fixes-off')).toHaveTextContent('PLUGIN_REMEDIATION_TOOLCHAINS=off');
  });

  it('remediation off: says so (PLUGIN_REMEDIATION_ENABLED=false)', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([], { enabled: false }));
    render(<ToolchainFixesCard allowed canWrite onPublished={jest.fn<() => void>()} />);
    expect(await screen.findByTestId('toolchain-fixes-off')).toHaveTextContent('PLUGIN_REMEDIATION_ENABLED=false');
  });

  it('remediation off: Approve and Resume publish are locked (the route answers 503); Reject stays', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([fix()], { enabled: false }));
    await card();
    expect(screen.getByRole('button', { name: 'Approve 1.1.32' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Reject 1.1.32' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a 503 on approve (the operator turned remediation off meanwhile) shows the off notice', async () => {
    const { ApiError } = await import('../src/lib/api/errors');
    fns.approveToolchainFix.mockImplementation(() => Promise.reject(new ApiError('Plugin remediation is turned off by the operator', 503, 'SERVICE_UNAVAILABLE')));
    await card();
    fireEvent.click(screen.getByRole('button', { name: 'Approve 1.1.32' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'step-up' })).getByRole('button', { name: 'Confirm identity' }));
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeInTheDocument();
  });

  it('a candidate moved to needs review after repeated gate refusals says why', async () => {
    fns.listToolchainFixes.mockImplementation(() => list([fix({ stage: 'needs_review', error: 'GATE_REFUSED' })]));
    const item = await card();
    expect(item).toHaveTextContent(/failed the build gate/i);
    expect(screen.queryByRole('button', { name: 'Approve 1.1.32' })).not.toBeInTheDocument();
  });

  it('without plugins:write it reads nothing and says what is needed', () => {
    render(<ToolchainFixesCard allowed={false} canWrite={false} onPublished={jest.fn<() => void>()} />);
    expect(screen.getByTestId('toolchain-fixes')).toHaveTextContent('plugins:write');
    expect(fns.listToolchainFixes).not.toHaveBeenCalled();
  });
});
