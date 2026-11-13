// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's Toolchain console (docs/plans/bootstrap-image-versioning.md
 * §6, §8, §9, §11).
 *
 * The properties that matter:
 *   - the page is gated on `toolchain:operate` (declared once on the nav entry)
 *     and is "not available" outside the system org, without a single read;
 *   - "Set as default" shows every guard and the blast radius BEFORE the step-up,
 *     then POSTs with `expectedCurrentDefault`; a guard refusal or
 *     TOOLCHAIN_DEFAULT_CHANGED keeps the dialog open and explains (the latter
 *     refreshes the preview, so the next confirm carries the new default);
 *   - promoting past the canary gate needs a written reason;
 *   - canary membership is a PUT of the whole set; the gate shows its numbers;
 *   - yank needs a reason and shows the restored default; notify, history
 *     rollback and cleanup delete each step up;
 *   - the managed-plugin note links to the console only for operators.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { useState, type ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { mockAuthGuard, pageToast } from './helpers/pageMocks';
import ToolchainConsolePage from '../pages/dashboard/toolchain';
import { ToolchainManagedNote, PluginLifecycleModal } from '../src/components/plugin/PluginLifecycleModal';
import { ApiError } from '../src/lib/api/errors';
import { resolvePageGate } from '../src/lib/page-access';
import { NAV_SECTIONS } from '../src/lib/nav';
import {
  classifySetDefaultError, gateFromDetails, platformBlastRadiusText, previousDefault,
} from '../src/lib/toolchain-console';
import type { PluginSummary } from '../src/lib/api/domains/plugins';
import type { ToolchainConsoleRelease, ToolchainDefaultPreview } from '../src/types/toolchain';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule());

// StepUpModal stand-in that behaves like the real one where it matters: the
// details render inside it, `confirmDisabledReason` blocks confirming, and
// after `onConfirmed` resolves it calls `onClose`.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, details, onConfirmed, onClose, confirmDisabledReason }: {
    action: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; confirmDisabledReason?: string | null;
  }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <div>{details}</div>
      {confirmDisabledReason && <p data-testid="step-up-blocked">{confirmDisabledReason}</p>}
      <button
        type="button"
        disabled={!!confirmDisabledReason}
        onClick={async () => { await onConfirmed('step-up-token'); onClose(); }}
      >
        Confirm identity
      </button>
      <button type="button" onClick={onClose}>Cancel step-up</button>
    </div>
  ),
}));

// OrgPicker stand-in: a plain text box that reports the id typed.
jest.mock('@/components/ui/OrgPicker', () => ({
  __esModule: true,
  OrgPicker: ({ value, onChange, 'aria-label': label }: { value: string; onChange: (v: string) => void; 'aria-label'?: string }) => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const downloadCsv = jest.fn<AnyFn>();
jest.mock('@/lib/csv-export', () => ({
  __esModule: true,
  downloadCsv: (...a: unknown[]) => downloadCsv(...a),
  datedFilename: (p: string) => `${p}-2026-11-13`,
}));

const fns = {
  listToolchainReleases: jest.fn<AnyFn>(),
  getToolchainAdoption: jest.fn<AnyFn>(),
  getToolchainCanary: jest.fn<AnyFn>(),
  setToolchainRollout: jest.fn<AnyFn>(),
  getToolchainDefaultPreview: jest.fn<AnyFn>(),
  setToolchainPlatformDefault: jest.fn<AnyFn>(),
  updateToolchainReleaseNotes: jest.fn<AnyFn>(),
  deprecateToolchainRelease: jest.fn<AnyFn>(),
  yankToolchainRelease: jest.fn<AnyFn>(),
  deleteToolchainRelease: jest.fn<AnyFn>(),
  getToolchainDefaultHistory: jest.fn<AnyFn>(),
  getToolchainAffected: jest.fn<AnyFn>(),
  notifyToolchainAffected: jest.fn<AnyFn>(),
  getToolchainCleanup: jest.fn<AnyFn>(),
  deprecatePlugin: jest.fn<AnyFn>(),
  yankPlugin: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (fns as Record<string, (...x: unknown[]) => unknown>)[k](...a) }),
}));

const SYSTEM_ORG = '000000000000000000000001';
const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const versions = { pipelineManager: '3.4.1', awsCdk: '2.200.0', cdkAssets: '3.1.0', esbuild: '0.25.0', pnpm: '10.1.0', node: '22.12.0' };
const scan = (critical = 0) => ({ scannedAt: '2026-11-01T00:00:00Z', criticalFixable: critical, highFixable: 0, kev: 0 });

const release = (releaseVersion: string, over: Partial<ToolchainConsoleRelease> = {}): ToolchainConsoleRelease => ({
  releaseVersion,
  status: 'available',
  complete: true,
  createdAt: '2026-11-01T00:00:00Z',
  releaseNotes: null,
  toolchain: versions,
  halves: {
    bootstrap: { digest: `sha256:aaaa${releaseVersion.replace(/\./g, '')}bbbbccccdddd`, scan: scan() },
    synth: { digest: `sha256:eeee${releaseVersion.replace(/\./g, '')}ffff00001111`, scan: scan(2) },
  },
  canaryOrgCount: 0,
  ...over,
});

const RELEASES = [
  release('1.5.0', { status: 'canary', canaryOrgCount: 2, releaseNotes: 'CDK 2.210' }),
  release('1.4.2', { status: 'default' }),
  release('1.4.1'),
  release('1.3.0', { status: 'yanked' }),
];

const preview = (over: Partial<ToolchainDefaultPreview> = {}): ToolchainDefaultPreview => ({
  blastRadius: { followingPipelines: 40, followingOrgs: 7, orgsWithOwnDefault: 3, pinnedPipelines: 5 },
  guards: [
    { code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', ok: true },
    { code: 'TOOLCHAIN_GUARD_UNSCANNED', ok: true },
    { code: 'TOOLCHAIN_GUARD_VULN_FLOOR', ok: true },
    { code: 'TOOLCHAIN_GUARD_METADATA', ok: true },
    { code: 'TOOLCHAIN_GUARD_CANARY_GATE', ok: true },
  ],
  currentDefault: '1.4.2',
  ...over,
});

const GATE = { passes: false, runs: 12, orgs: 2, failureRate: 4.5, defaultFailureRate: 2, thresholds: { n: 20, m: 2, t: 5 } };

function asOperator(over: Record<string, unknown> = {}) {
  return mockAuthGuard({
    user: { id: 'op-1', organizationId: SYSTEM_ORG, permissions: ['toolchain:operate'] },
    can: (p: string) => p === 'toolchain:operate',
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  asOperator();
  fns.listToolchainReleases.mockImplementation(() => ok({ platformDefault: '1.4.2', releases: RELEASES }));
  fns.getToolchainDefaultPreview.mockImplementation(() => ok(preview()));
  fns.setToolchainPlatformDefault.mockImplementation((v: unknown) => ok({ platformDefault: v }));
  fns.getToolchainCanary.mockImplementation(() => ok({
    members: [
      { orgId: 'org-a', orgName: 'Acme', hasOrgDefault: false },
      { orgId: 'org-b', orgName: 'Beta', hasOrgDefault: true },
    ],
    gate: GATE,
  }));
  fns.setToolchainRollout.mockImplementation((_v: unknown, ids: unknown) => ok({
    members: (ids as string[]).map((id) => ({ orgId: id, orgName: id === 'org-c' ? 'Gamma' : id, hasOrgDefault: id === 'org-c' })),
  }));
  fns.getToolchainAdoption.mockImplementation(() => ok({
    releaseVersion: '1.5.0',
    byResolvedVia: { pin: 1, 'org-default': 2, canary: 9, default: 0 },
    orgs: [{ orgId: 'org-a', orgName: 'Acme', pipelines: 9, pinned: 1, orgDefault: false }],
  }));
  fns.getToolchainAffected.mockImplementation(() => ok({
    releaseVersion: '1.5.0',
    orgs: [{ orgId: 'org-a', orgName: 'Acme', pipelineCount: 2, pipelineIds: ['p1', 'p2'] }],
  }));
  fns.notifyToolchainAffected.mockImplementation(() => ok({ notifiedOrgs: 1, notifiedPipelines: 2 }));
  fns.getToolchainDefaultHistory.mockImplementation(() => ok({
    history: [
      { releaseVersion: '1.4.2', previousReleaseVersion: '1.4.1', kind: 'set', setBy: 'op-1', setAt: '2026-11-10T00:00:00Z', reason: null },
      { releaseVersion: '1.4.1', previousReleaseVersion: null, kind: 'initial', setBy: 'service:deploy-bootstrap', setAt: '2026-10-01T00:00:00Z', reason: null },
    ],
  }));
  fns.getToolchainCleanup.mockImplementation(() => ok({ candidates: [{ releaseVersion: '1.2.0', createdAt: '2026-08-01T00:00:00Z' }] }));
  fns.yankToolchainRelease.mockImplementation(() => ok({ restoredDefault: '1.4.1' }));
  fns.deleteToolchainRelease.mockImplementation(() => ok({}));
  fns.deprecateToolchainRelease.mockImplementation(() => ok({}));
  fns.updateToolchainReleaseNotes.mockImplementation(() => ok({}));
});

const stepUp = () => screen.getByRole('dialog', { name: 'step-up' });
const confirmStepUp = () => fireEvent.click(within(stepUp()).getByRole('button', { name: 'Confirm identity' }));
const rowOf = (text: string) => within(screen.getByRole('table')).getByText(text).closest('tr')!;
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));

async function renderConsole() {
  render(<ToolchainConsolePage />);
  await screen.findByTestId('toolchain-releases');
}

describe('Toolchain console: access', () => {
  it('declares toolchain:operate as the read gate, on a system-org-only nav entry', () => {
    expect(resolvePageGate('/dashboard/toolchain')).toEqual({ permission: 'toolchain:operate' });
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === '/dashboard/toolchain');
    expect(item).toMatchObject({ requiredPermission: 'toolchain:operate', systemOrgOnly: true });
  });

  it('is locked without toolchain:operate: access denied, no reads', () => {
    mockAuthGuard({
      isReady: false,
      accessDenied: { kind: 'permission', permission: 'toolchain:operate', pathname: '/dashboard/toolchain' },
    });
    render(<ToolchainConsolePage />);
    expect(screen.getByTestId('access-denied')).toHaveTextContent('toolchain:operate');
    expect(fns.listToolchainReleases).not.toHaveBeenCalled();
  });

  it('is not available in a tenant org, even to a superadmin (the routes are system-org only)', () => {
    mockAuthGuard({ isSuperAdmin: true, user: { id: 'sa', organizationId: 'org-1' } });
    render(<ToolchainConsolePage />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(fns.listToolchainReleases).not.toHaveBeenCalled();
  });

  it('a read-only session sees the console with every write locked', async () => {
    asOperator({ isReadOnly: true });
    await renderConsole();
    expect(screen.getByRole('button', { name: 'Set as default 1.4.1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Yank 1.4.1' })).toBeDisabled();
  });
});

describe('Toolchain console: Releases', () => {
  it('lists each release with toolchain versions, both digests and scans, status and notes', async () => {
    await renderConsole();
    expect(screen.getByTestId('toolchain-platform-default')).toHaveTextContent('1.4.2');
    const row = rowOf('1.5.0');
    expect(row).toHaveTextContent('pipeline-manager 3.4.1');
    expect(row).toHaveTextContent('aws-cdk 2.200.0');
    expect(row).toHaveTextContent('cdk-assets 3.1.0');
    expect(row).toHaveTextContent('bootstrap: aaaa150bbbbc');
    expect(row).toHaveTextContent('synth: eeee150ffff0');
    expect(row).toHaveTextContent('bootstrap: No fixable critical or high findings');
    expect(row).toHaveTextContent('synth: 2 fixable critical');
    expect(row).toHaveTextContent('Canary');
    expect(row).toHaveTextContent('2 canary orgs');
    expect(row).toHaveTextContent('CDK 2.210');
    expect(rowOf('1.4.2')).toHaveTextContent('Platform default');
    // The default can't be promoted again; a yanked release can't be yanked again.
    expect(screen.getByRole('button', { name: 'Set as default 1.4.2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Yank 1.3.0' })).toBeDisabled();
  });

  it('Edit notes steps up and PATCHes the notes', async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes 1.5.0' }));
    const notes = within(stepUp()).getByLabelText('Release notes');
    expect(notes).toHaveValue('CDK 2.210');
    fireEvent.change(notes, { target: { value: 'CDK 2.211, esbuild 0.25' } });
    confirmStepUp();
    await waitFor(() => expect(fns.updateToolchainReleaseNotes).toHaveBeenCalledWith('1.5.0', 'CDK 2.211, esbuild 0.25', 'step-up-token'));
  });

  it('"Add canary orgs" opens the Canary panel on that release', async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Add canary orgs 1.4.1' }));
    await screen.findByTestId('toolchain-canary');
    expect(fns.getToolchainCanary).toHaveBeenCalledWith('1.4.1', expect.anything());
  });
});

describe('Toolchain console: Set as default', () => {
  it('shows the guards and the blast radius, then steps up and POSTs with expectedCurrentDefault', async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    const guards = await within(stepUp()).findByTestId('toolchain-guards');
    expect(fns.getToolchainDefaultPreview).toHaveBeenCalledWith('1.4.1', expect.objectContaining({ thresholds: undefined }));
    expect(within(guards).getAllByRole('listitem')).toHaveLength(5);
    expect(guards).toHaveTextContent('Both halves present and live');
    expect(guards).toHaveTextContent('Canary gate passed');
    expect(screen.getByTestId('toolchain-platform-blast-radius')).toHaveTextContent(
      "40 pipelines in 7 orgs follow the platform default and will move on their next run; 3 orgs have their own default and 5 pipelines are pinned, so they won't move.",
    );
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenCalledWith('1.4.1', { expectedCurrentDefault: '1.4.2' }, 'step-up-token'));
    expect(pageToast.success).toHaveBeenCalledWith('1.4.1 is now the platform default');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'step-up' })).not.toBeInTheDocument());
    expect(fns.listToolchainReleases).toHaveBeenCalledTimes(2);
  });

  it('a failing hard guard blocks the confirm and says which', async () => {
    fns.getToolchainDefaultPreview.mockImplementation(() => ok(preview({
      guards: [
        { code: 'TOOLCHAIN_GUARD_PAIR_INCOMPLETE', ok: true },
        { code: 'TOOLCHAIN_GUARD_UNSCANNED', ok: false, detail: 'cdk-synth is not scanned yet' },
      ],
    })));
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    expect(screen.getByText('cdk-synth is not scanned yet')).toBeInTheDocument();
    expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('Refused by Both halves scanned.');
    expect(within(stepUp()).getByRole('button', { name: 'Confirm identity' })).toBeDisabled();
  });

  it('TOOLCHAIN_DEFAULT_CHANGED keeps the dialog open, refreshes the preview, and the next confirm carries the new default', async () => {
    fns.setToolchainPlatformDefault.mockImplementationOnce(() => Promise.reject(
      new ApiError('The platform default changed', 409, 'TOOLCHAIN_DEFAULT_CHANGED', { expectedCurrentDefault: '1.4.2', currentDefault: '1.4.3' }),
    ));
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    fns.getToolchainDefaultPreview.mockImplementation(() => ok(preview({ currentDefault: '1.4.3' })));
    confirmStepUp();
    expect(await screen.findByTestId('toolchain-set-default-refusal')).toHaveTextContent('The platform default changed to 1.4.3 while you were reviewing');
    await waitFor(() => expect(fns.getToolchainDefaultPreview).toHaveBeenCalledTimes(2));
    expect(stepUp()).toHaveTextContent('Current platform default: 1.4.3');
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenLastCalledWith('1.4.1', { expectedCurrentDefault: '1.4.3' }, 'step-up-token'));
  });

  it('a canary-gate refusal shows the gate numbers and asks for a reason; the retry overrides with it', async () => {
    fns.setToolchainPlatformDefault.mockImplementationOnce(() => Promise.reject(
      new ApiError('Release 1.4.1 has not passed the canary gate', 422, 'TOOLCHAIN_GUARD_CANARY_GATE', {
        gate: { passed: false, countedRuns: 3, orgs: 1, failureRate: 10, baselineFailureRate: 2, params: { minRuns: 20, minOrgs: 2, maxFailurePointsAboveDefault: 5 } },
      }),
    ));
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    confirmStepUp();
    const gate = await screen.findByTestId('toolchain-refusal-gate');
    expect(gate).toHaveTextContent('Synth runs: 3 of 20 required');
    expect(gate).toHaveTextContent('Orgs: 1 of 2 required');
    expect(gate).toHaveTextContent("Failure rate: 10% vs the default's 2% (8 points over; at most 5)");
    expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('give an override reason');
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'hotfix for a synth regression' } });
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenLastCalledWith(
      '1.4.1', { expectedCurrentDefault: '1.4.2', overrideReason: 'hotfix for a synth regression' }, 'step-up-token',
    ));
  });

  it('any other guard refusal is named', async () => {
    fns.setToolchainPlatformDefault.mockImplementationOnce(() => Promise.reject(
      new ApiError('over the floor', 422, 'TOOLCHAIN_GUARD_VULN_FLOOR', {}),
    ));
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    confirmStepUp();
    expect(await screen.findByTestId('toolchain-set-default-refusal')).toHaveTextContent('Within the fixable-Critical floor: refused. over the floor');
    expect(stepUp()).toBeInTheDocument();
  });

  it('when the preview says the canary gate has not passed, the override needs a reason', async () => {
    fns.getToolchainDefaultPreview.mockImplementation(() => ok(preview({
      guards: [{ code: 'TOOLCHAIN_GUARD_CANARY_GATE', ok: false, detail: '12 of 20 synth runs' }],
    })));
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Set as default 1.4.1' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('The canary gate has not passed: give an override reason.');
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: '   ' } });
    expect(within(stepUp()).getByRole('button', { name: 'Confirm identity' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'canary too small' } });
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenCalledWith(
      '1.4.1', { expectedCurrentDefault: '1.4.2', overrideReason: 'canary too small' }, 'step-up-token',
    ));
  });
});

describe('Toolchain console: Canary', () => {
  async function openCanary() {
    await renderConsole();
    tab('Canary');
    return screen.findByTestId('toolchain-canary');
  }

  it('lists members, flags an org with its own default, and shows the gate numbers against the thresholds', async () => {
    await openCanary();
    expect(fns.getToolchainCanary).toHaveBeenCalledWith('1.5.0', expect.objectContaining({ thresholds: undefined }));
    const members = screen.getByTestId('toolchain-canary-members');
    expect(within(members).getByText('Beta').closest('li')).toHaveTextContent('has its own default — canary has no effect');
    expect(within(members).getByText('Acme').closest('li')).not.toHaveTextContent('no effect');
    const numbers = screen.getByTestId('toolchain-gate-numbers');
    expect(numbers).toHaveTextContent('Synth runs: 12 of 20 required');
    expect(numbers).toHaveTextContent('Orgs: 2 of 2 required');
    expect(numbers).toHaveTextContent("Failure rate: 4.5% vs the default's 2% (2.5 points over; at most 5)");
    expect(screen.getByTestId('toolchain-gate')).toHaveTextContent('Not passed');
    expect(screen.getByRole('button', { name: 'Promote to platform default' })).toBeDisabled();
  });

  it('adds an org with a PUT of the whole set, and warns when the org has its own default', async () => {
    await openCanary();
    fireEvent.change(screen.getByLabelText('Add canary org'), { target: { value: 'org-c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add to canary' }));
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainRollout).toHaveBeenCalledWith('1.5.0', ['org-a', 'org-b', 'org-c'], 'step-up-token'));
    expect(pageToast.warning).toHaveBeenCalledWith('Gamma has its own default — canary has no effect.');
  });

  it('removes an org with a PUT of the rest', async () => {
    await openCanary();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Acme' }));
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainRollout).toHaveBeenCalledWith('1.5.0', ['org-b'], 'step-up-token'));
  });

  it('applied thresholds re-read the gate with them and carry into the promotion', async () => {
    await openCanary();
    fireEvent.change(screen.getByLabelText('Minimum synth runs'), { target: { value: '10' } });
    fns.getToolchainCanary.mockImplementation(() => ok({ members: [], gate: { ...GATE, passes: true, thresholds: { n: 10, m: 2, t: 5 } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply thresholds' }));
    await waitFor(() => expect(fns.getToolchainCanary).toHaveBeenLastCalledWith('1.5.0', expect.objectContaining({ thresholds: { n: 10, m: 2, t: 5 } })));
    const promote = await screen.findByRole('button', { name: 'Promote to platform default' });
    await waitFor(() => expect(promote).toBeEnabled());
    fireEvent.click(promote);
    await within(stepUp()).findByTestId('toolchain-guards');
    expect(fns.getToolchainDefaultPreview).toHaveBeenCalledWith('1.5.0', expect.objectContaining({ thresholds: { n: 10, m: 2, t: 5 } }));
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenCalledWith(
      '1.5.0', { expectedCurrentDefault: '1.4.2', canaryGate: { n: 10, m: 2, t: 5 } }, 'step-up-token',
    ));
  });

  it('"Override and promote" asks for the reason up front', async () => {
    await openCanary();
    fireEvent.click(screen.getByRole('button', { name: 'Override and promote…' }));
    await within(stepUp()).findByTestId('toolchain-guards');
    expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('give an override reason');
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'urgent CDK fix' } });
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenCalledWith(
      '1.5.0', { expectedCurrentDefault: '1.4.2', overrideReason: 'urgent CDK fix' }, 'step-up-token',
    ));
  });
});

describe('Toolchain console: Yank, Adoption, Affected, History, Cleanup', () => {
  it('yank needs a reason and shows the restored default', async () => {
    await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Yank 1.4.2' }));
    expect(stepUp()).toHaveTextContent('yanking it restores the previous default');
    expect(screen.getByTestId('step-up-blocked')).toHaveTextContent('A reason is required');
    fireEvent.change(screen.getByLabelText('Yank reason'), { target: { value: 'synth crashes on cdk-assets 3.1' } });
    confirmStepUp();
    await waitFor(() => expect(fns.yankToolchainRelease).toHaveBeenCalledWith('1.4.2', 'synth crashes on cdk-assets 3.1', 'step-up-token'));
    expect(await screen.findByTestId('toolchain-yank-result')).toHaveTextContent('The platform default was restored to 1.4.1.');
  });

  it('adoption shows counts by resolvedVia and per org, and exports CSV', async () => {
    await renderConsole();
    tab('Adoption');
    const via = await screen.findByTestId('toolchain-adoption-via');
    expect(within(via).getByText('Canary').nextSibling).toHaveTextContent('9');
    expect(within(via).getByText('Pinned').nextSibling).toHaveTextContent('1');
    expect(screen.getByText('Acme').closest('tr')).toHaveTextContent('9');
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(downloadCsv).toHaveBeenCalledWith(
      [{ releaseVersion: '1.5.0', orgId: 'org-a', orgName: 'Acme', pipelines: 9, pinned: 1, orgDefault: false }],
      ['releaseVersion', 'orgId', 'orgName', 'pipelines', 'pinned', 'orgDefault'],
      'toolchain-adoption-1.5.0-2026-11-13',
    );
  });

  it('affected lists stranded pipelines; "Notify affected owners" confirms, then notifies', async () => {
    await renderConsole();
    tab('Affected');
    await screen.findByTestId('toolchain-affected');
    expect(fns.getToolchainAffected).toHaveBeenCalledWith('1.5.0', expect.anything());
    expect(screen.getByText('Acme').closest('tr')).toHaveTextContent('p1, p2');
    fireEvent.click(screen.getByRole('button', { name: /notify affected owners/i }));
    expect(screen.getByTestId('toolchain-notify-summary')).toHaveTextContent('The owners of 2 pipelines in 1 org');
    expect(fns.notifyToolchainAffected).not.toHaveBeenCalled();
    confirmStepUp();
    await waitFor(() => expect(fns.notifyToolchainAffected).toHaveBeenCalledWith('1.5.0', 'step-up-token'));
    expect(await screen.findByTestId('toolchain-notified')).toHaveTextContent('Notified 2 pipeline owners in 1 org.');
  });

  it('history "Set previous as default" promotes the previous release through the same flow', async () => {
    await renderConsole();
    tab('History');
    await screen.findByTestId('toolchain-history');
    fireEvent.click(await screen.findByRole('button', { name: 'Set previous as default' }));
    expect(stepUp()).toHaveTextContent('Set the previous release, 1.4.1, as the platform default');
    await within(stepUp()).findByTestId('toolchain-guards');
    expect(fns.getToolchainDefaultPreview).toHaveBeenCalledWith('1.4.1', expect.anything());
    confirmStepUp();
    await waitFor(() => expect(fns.setToolchainPlatformDefault).toHaveBeenCalledWith('1.4.1', { expectedCurrentDefault: '1.4.2' }, 'step-up-token'));
  });

  it('cleanup deletes a candidate after step-up', async () => {
    await renderConsole();
    tab('Cleanup');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1.2.0' }));
    confirmStepUp();
    await waitFor(() => expect(fns.deleteToolchainRelease).toHaveBeenCalledWith('1.2.0', 'step-up-token'));
    await waitFor(() => expect(fns.getToolchainCleanup).toHaveBeenCalledTimes(2));
  });
});

describe('toolchain-console helpers', () => {
  it('blast radius in the plan\'s words, singular and with nothing held back', () => {
    expect(platformBlastRadiusText({ followingPipelines: 1, followingOrgs: 1, orgsWithOwnDefault: 1, pinnedPipelines: 1 }))
      .toBe("1 pipeline in 1 org follow the platform default and will move on their next run; 1 org has its own default and 1 pipeline is pinned, so they won't move.");
    expect(platformBlastRadiusText({ followingPipelines: 4, followingOrgs: 2, orgsWithOwnDefault: 0, pinnedPipelines: 0 }))
      .toBe('4 pipelines in 2 orgs follow the platform default and will move on their next run.');
  });

  it('reads the gate from either the console or the service shape', () => {
    expect(gateFromDetails({ gate: GATE })).toEqual(GATE);
    expect(gateFromDetails({})).toBeNull();
  });

  it('classifies refusals', () => {
    expect(classifySetDefaultError(new ApiError('x', 409, 'TOOLCHAIN_DEFAULT_CHANGED', { currentDefault: null })).kind).toBe('changed');
    expect(classifySetDefaultError(new ApiError('x', 422, 'TOOLCHAIN_GUARD_METADATA')).kind).toBe('guard');
    expect(classifySetDefaultError(new Error('boom')).kind).toBe('other');
  });

  it('previous default is the one before the current', () => {
    const h = [
      { releaseVersion: '1.4.2', previousReleaseVersion: '1.4.1', kind: 'set' as const, setBy: 'a', setAt: 't', reason: null },
    ];
    expect(previousDefault(h, '1.4.2')).toBe('1.4.1');
    expect(previousDefault([], '1.4.2')).toBeNull();
  });
});

describe('managed toolchain note', () => {
  it('links to the console only for toolchain:operate holders', () => {
    const { unmount } = render(<ToolchainManagedNote canOperateToolchain />);
    expect(screen.getByRole('link', { name: 'Toolchain console' })).toHaveAttribute('href', '/dashboard/toolchain');
    unmount();
    render(<ToolchainManagedNote canOperateToolchain={false} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/managed in the Toolchain console/)).toBeInTheDocument();
  });

  it('PluginLifecycleModal passes the permission through for a managed version', () => {
    const managed = { id: 'p1', name: 'cdk-synth', version: '1.4.2', yankedAt: null, deprecatedAt: null } as unknown as PluginSummary;
    function Harness({ can }: { can: boolean }) {
      const [open, setOpen] = useState(true);
      return open ? <PluginLifecycleModal plugin={managed} action="yank" canOperateToolchain={can} onClose={() => setOpen(false)} onDone={() => undefined} /> : null;
    }
    const { unmount } = render(<Harness can />);
    expect(screen.getByRole('link', { name: 'Toolchain console' })).toBeInTheDocument();
    unmount();
    render(<Harness can={false} />);
    expect(screen.queryByRole('link', { name: 'Toolchain console' })).not.toBeInTheDocument();
  });
});
