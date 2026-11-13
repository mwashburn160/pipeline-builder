// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization → "Pipeline toolchain" (docs/plans/
 * bootstrap-image-versioning.md §5, §11).
 *
 * The properties that matter:
 *   - read-only without `toolchain:manage` — shown, not hidden;
 *   - every write goes through the step-up confirmation, which states the
 *     blast radius, and only then calls the API with the token;
 *   - "Follow platform default" DELETES the org default; "Revert to previous"
 *     restores the previous history entry;
 *   - eligibility refusals surface in words; canary has "no effect" while an
 *     org default is set; a team names the root org it inherits from.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { mockOrgHierarchy } from './helpers/pageMocks';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PipelineToolchainSettings, blastRadiusText } from '../src/components/settings/PipelineToolchainSettings';
import { ApiError } from '../src/lib/api/errors';
import type { ToolchainOrgDefaultView, ToolchainRelease } from '../src/types/toolchain';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

// StepUpModal stand-in: shows the action and the details, and confirming yields a token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, details, onConfirmed }: { action: string; details?: unknown; onConfirmed: (t: string) => void }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <div>{details as never}</div>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm identity</button>
    </div>
  ),
}));

jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
const getToolchainOrgDefault = jest.fn<AnyFn>();
const getToolchainEligible = jest.fn<AnyFn>();
const getToolchainOrgDefaultHistory = jest.fn<AnyFn>();
const setToolchainOrgDefault = jest.fn<AnyFn>();
const clearToolchainOrgDefault = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getToolchainOrgDefault: (...a: unknown[]) => getToolchainOrgDefault(...a),
    getToolchainEligible: (...a: unknown[]) => getToolchainEligible(...a),
    getToolchainOrgDefaultHistory: (...a: unknown[]) => getToolchainOrgDefaultHistory(...a),
    setToolchainOrgDefault: (...a: unknown[]) => setToolchainOrgDefault(...a),
    clearToolchainOrgDefault: (...a: unknown[]) => clearToolchainOrgDefault(...a),
  },
}));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });

const versions = { pipelineManager: '3.4.1', awsCdk: '2.200.0', cdkAssets: '3.1.0', esbuild: '0.25.0', pnpm: '10.1.0', node: '22.12.0' };
const release = (releaseVersion: string, over: Partial<ToolchainRelease> = {}): ToolchainRelease => ({
  releaseVersion,
  status: 'available',
  relation: 'older',
  toolchain: versions,
  releaseNotes: null,
  scan: { scannedAt: '2026-11-01T00:00:00Z', criticalFixable: 0, highFixable: 0, kev: 0 },
  ...over,
});

const view = (over: Partial<ToolchainOrgDefaultView> = {}): ToolchainOrgDefaultView => ({
  effective: { releaseVersion: '1.4.2', resolvedVia: 'default' },
  orgDefault: null,
  inheritedFrom: null,
  canary: { member: false, releaseVersion: null, effective: false },
  platformDefault: '1.4.2',
  counts: { pipelines: 10, pinned: 2, behind: 1 },
  ...over,
});

const RELEASES = [
  release('1.5.0', { status: 'canary', relation: 'newer', releaseNotes: 'CDK 2.210' }),
  release('1.4.2', { status: 'default', relation: 'current' }),
  release('1.4.1'),
  release('1.3.0', { status: 'yanked' }),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgHierarchy();
  getToolchainOrgDefault.mockImplementation(() => ok(view()));
  getToolchainEligible.mockImplementation(() => ok({ platformDefault: '1.4.2', releases: RELEASES }));
  getToolchainOrgDefaultHistory.mockImplementation(() => ok({ history: [] }));
  setToolchainOrgDefault.mockImplementation(() => ok({ orgDefault: { releaseVersion: '1.4.1', setBy: 'u1', setAt: '2026-11-13T00:00:00Z', reason: null } }));
  clearToolchainOrgDefault.mockImplementation(() => ok({ orgDefault: null }));
});

const renderPanel = (canEdit = true, readOnly = false) =>
  render(<PipelineToolchainSettings canEdit={canEdit} readOnly={readOnly} />);

describe('PipelineToolchainSettings', () => {
  it('shows the effective release and why, plus the counts', async () => {
    renderPanel();
    const status = await screen.findByTestId('toolchain-status');
    expect(status).toHaveTextContent(/effective release: 1\.4\.2/i);
    expect(status).toHaveTextContent(/the platform default/i);
    expect(screen.getByTestId('toolchain-counts')).toHaveTextContent('10 pipelines · 2 pinned · 1 behind default');
  });

  it('is READ-ONLY without toolchain:manage: shown, every control locked, no save', async () => {
    renderPanel(false);
    const follow = await screen.findByRole('radio', { name: /follow platform default \(currently 1\.4\.2\)/i });
    expect(follow).toBeChecked();
    expect(follow).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Release 1.4.1' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save toolchain default/i })).not.toBeInTheDocument();
    expect(screen.getByText(/needs the manage pipeline toolchain permission/i)).toBeInTheDocument();
  });

  it('is editable with toolchain:manage; Save waits for a change', async () => {
    renderPanel(true);
    const r = await screen.findByRole('radio', { name: 'Release 1.4.1' });
    expect(r).toBeEnabled();
    const save = screen.getByRole('button', { name: /save toolchain default/i });
    expect(save).toBeDisabled();
    fireEvent.click(r);
    expect(save).toBeEnabled();
  });

  it('lists eligible releases with notes, toolchain versions, scan and newer/older labels', async () => {
    renderPanel();
    const label = (await screen.findByRole('radio', { name: 'Release 1.5.0' })).closest('label')!;
    expect(label).toHaveTextContent('Canary');
    expect(label).toHaveTextContent('newer');
    expect(label).toHaveTextContent('CDK 2.210');
    expect(label).toHaveTextContent(/aws-cdk 2\.200\.0/);
    expect(label).toHaveTextContent(/no fixable critical or high findings/i);
    expect(screen.getByRole('radio', { name: 'Release 1.4.1' }).closest('label')).toHaveTextContent('older');
  });

  it('a yanked release is labelled and cannot be newly chosen', async () => {
    renderPanel();
    const yanked = await screen.findByRole('radio', { name: 'Release 1.3.0' });
    expect(yanked).toBeDisabled();
    expect(yanked.closest('label')).toHaveTextContent('Yanked');
  });

  it('save opens the step-up with the blast radius, THEN PUTs releaseVersion + reason with the token', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('radio', { name: 'Release 1.4.1' }));
    fireEvent.change(screen.getByPlaceholderText(/hold at/i), { target: { value: 'hold for CDK upgrade' } });
    fireEvent.click(screen.getByRole('button', { name: /save toolchain default/i }));

    const dialog = screen.getByRole('dialog', { name: 'step-up' });
    expect(setToolchainOrgDefault).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/set the organization toolchain default to 1\.4\.1/i);
    expect(dialog).toHaveTextContent("8 of your 10 pipelines will move on their next run; 2 pinned pipelines won't.");

    fireEvent.click(within(dialog).getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(setToolchainOrgDefault).toHaveBeenCalledWith(
      { releaseVersion: '1.4.1', reason: 'hold for CDK upgrade' }, 'step-up-token',
    ));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Organization default set to 1.4.1'));
    expect(getToolchainOrgDefault).toHaveBeenCalledTimes(2); // refreshed after the write
  });

  it('passes the write\'s warnings on', async () => {
    setToolchainOrgDefault.mockImplementation(() => ok({ orgDefault: {}, warnings: ['Release 1.4.1 has 1 fixable critical finding'] }));
    renderPanel();
    fireEvent.click(await screen.findByRole('radio', { name: 'Release 1.4.1' }));
    fireEvent.click(screen.getByRole('button', { name: /save toolchain default/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Release 1.4.1 has 1 fixable critical finding'));
  });

  it('surfaces an ineligibility refusal in words', async () => {
    setToolchainOrgDefault.mockImplementation(() => Promise.reject(
      new ApiError('Release 1.4.1 is not eligible', 400, 'TOOLCHAIN_RELEASE_NOT_ELIGIBLE'),
    ));
    renderPanel();
    fireEvent.click(await screen.findByRole('radio', { name: 'Release 1.4.1' }));
    fireEvent.click(screen.getByRole('button', { name: /save toolchain default/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm identity/i }));
    expect(await screen.findByText(/that release can.t be chosen/i)).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('"Follow platform default" DELETEs the org default (after step-up)', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.1', setBy: 'u1', setAt: '2026-11-01T00:00:00Z', reason: null },
    })));
    renderPanel();
    expect(await screen.findByRole('radio', { name: 'Release 1.4.1' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /follow platform default/i }));
    fireEvent.click(screen.getByRole('button', { name: /save toolchain default/i }));
    const dialog = screen.getByRole('dialog', { name: 'step-up' });
    expect(dialog).toHaveTextContent(/follow the platform toolchain default/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(clearToolchainOrgDefault).toHaveBeenCalledWith('step-up-token'));
    expect(setToolchainOrgDefault).not.toHaveBeenCalled();
  });

  it('"Revert to previous" restores the previous history entry', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.2', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.2', setBy: 'u1', setAt: '2026-11-10T00:00:00Z', reason: null },
    })));
    getToolchainOrgDefaultHistory.mockImplementation(() => ok({ history: [
      { releaseVersion: '1.4.2', setBy: 'alice', setAt: '2026-11-10T00:00:00Z', reason: 'try new' },
      { releaseVersion: '1.4.1', setBy: 'bob', setAt: '2026-11-01T00:00:00Z', reason: null },
    ] }));
    renderPanel();
    expect(await screen.findByTestId('toolchain-history')).toHaveTextContent('alice');
    fireEvent.click(screen.getByRole('button', { name: /revert to previous/i }));
    const dialog = screen.getByRole('dialog', { name: 'step-up' });
    expect(dialog).toHaveTextContent(/revert the organization toolchain default to 1\.4\.1/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(setToolchainOrgDefault).toHaveBeenCalledWith(
      { releaseVersion: '1.4.1', reason: 'Revert to previous' }, 'step-up-token',
    ));
  });

  it('reverting to a "followed the platform default" entry DELETEs', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.1', setBy: 'u1', setAt: '2026-11-10T00:00:00Z', reason: null },
    })));
    getToolchainOrgDefaultHistory.mockImplementation(() => ok({ history: [
      { releaseVersion: '1.4.1', setBy: 'alice', setAt: '2026-11-10T00:00:00Z', reason: null },
      { releaseVersion: null, setBy: 'bob', setAt: '2026-11-01T00:00:00Z', reason: null },
    ] }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /revert to previous/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(clearToolchainOrgDefault).toHaveBeenCalledWith('step-up-token'));
  });

  it('no Revert without a previous entry, and none for a read-only viewer', async () => {
    getToolchainOrgDefaultHistory.mockImplementation(() => ok({ history: [
      { releaseVersion: '1.4.1', setBy: 'alice', setAt: '2026-11-10T00:00:00Z', reason: null },
    ] }));
    renderPanel(false);
    await screen.findByTestId('toolchain-history');
    expect(screen.queryByRole('button', { name: /revert to previous/i })).not.toBeInTheDocument();
  });

  it('a team names the root org it inherits from', async () => {
    mockOrgHierarchy({ parentOrgId: 'root-1', parentOrgName: 'Acme Corp' });
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      inheritedFrom: 'root-1',
    })));
    renderPanel();
    expect(await screen.findByRole('radio', { name: /inherit from acme corp \(currently 1\.4\.1\)/i })).toBeChecked();
    expect(screen.getByTestId('toolchain-status')).toHaveTextContent(/inherited from acme corp/i);
  });

  it('a team WITH its own default still offers "Inherit from <root>", which DELETEs', async () => {
    mockOrgHierarchy({ parentOrgId: 'root-1', parentOrgName: 'Acme Corp' });
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.1', setBy: 'u1', setAt: '2026-11-01T00:00:00Z', reason: null },
    })));
    renderPanel();
    fireEvent.click(await screen.findByRole('radio', { name: /^inherit from acme corp$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save toolchain default/i }));
    expect(screen.getByRole('dialog', { name: 'step-up' })).toHaveTextContent(/inherit the toolchain from acme corp/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm identity/i }));
    await waitFor(() => expect(clearToolchainOrgDefault).toHaveBeenCalledWith('step-up-token'));
  });

  it('canary: says it applies when it does, and "no effect" while an org default is set', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.5.0', resolvedVia: 'canary' },
      canary: { member: true, releaseVersion: '1.5.0', effective: true },
    })));
    const { unmount } = renderPanel();
    expect(await screen.findByTestId('toolchain-canary')).toHaveTextContent(/in the canary for 1\.5\.0\./i);
    expect(screen.getByTestId('toolchain-canary')).not.toHaveTextContent(/no effect/i);
    unmount();

    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.4.1', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.4.1', setBy: 'u1', setAt: '2026-11-01T00:00:00Z', reason: null },
      canary: { member: true, releaseVersion: '1.5.0', effective: false },
    })));
    renderPanel();
    expect(await screen.findByTestId('toolchain-canary')).toHaveTextContent(/no effect while your org default is set/i);
  });

  it('warns when the org default is yanked or far behind', async () => {
    getToolchainOrgDefault.mockImplementation(() => ok(view({
      effective: { releaseVersion: '1.3.0', resolvedVia: 'org-default' },
      orgDefault: { releaseVersion: '1.3.0', setBy: 'u1', setAt: '2026-11-01T00:00:00Z', reason: null },
      platformDefault: '1.4.2',
    })));
    getToolchainEligible.mockImplementation(() => ok({ platformDefault: '1.4.2', releases: [
      ...RELEASES, release('1.3.5'), release('1.4.0', { scan: { scannedAt: 'x', criticalFixable: 2, highFixable: 0, kev: 0 } }),
    ] }));
    renderPanel();
    const list = await screen.findByTestId('toolchain-warnings');
    expect(list).toHaveTextContent(/1\.3\.0 was yanked/i);
    expect(list).toHaveTextContent(/4 releases behind the platform default/i);
    // The org's own yanked release stays checked (it still resolves) even though it can't be newly chosen.
    expect(screen.getByRole('radio', { name: 'Release 1.3.0' })).toBeChecked();
  });

  it('blastRadiusText: nothing moves when the target is already effective', () => {
    expect(blastRadiusText(view(), '1.4.2')).toBe('Your pipelines stay on 1.4.2; nothing moves.');
    expect(blastRadiusText(view({ counts: { pipelines: 1, pinned: 0, behind: 0 } }), '1.4.1'))
      .toBe('1 of your 1 pipeline will move on their next run.');
  });
});
