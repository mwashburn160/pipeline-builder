// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The remediation card on a plugin version (stage, fix version, cleared and
 * remaining findings with reasons, the patch diff, Approve / Reject behind
 * step-up), the version section's operator-off state, the findings panel's
 * package details and markers, and EditPluginModal's per-plugin upgrade level.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, title, details }: { onConfirmed: (t: string) => void; title?: string; details?: unknown }) => (
    <div role="dialog" aria-label={title}>
      {details as never}
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Confirm password</button>
    </div>
  ),
}));

const api = {
  approvePluginRemediation: jest.fn<AnyFn>(),
  rejectPluginRemediation: jest.fn<AnyFn>(),
  retryPluginRemediation: jest.fn<AnyFn>(),
  getPluginRemediationPatch: jest.fn<AnyFn>(),
  downloadPluginRemediationExport: jest.fn<AnyFn>(),
  listPluginRemediations: jest.fn<AnyFn>(),
  getPluginFindings: jest.fn<AnyFn>(),
  downloadPluginFindingsCsv: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { RemediationCard, PluginRemediationSection } from '../src/components/plugin/RemediationCard';
import { RemediationsPanel } from '../src/components/plugin/RemediationsPanel';
import { PluginFindingsPanel } from '../src/components/plugin/PluginFindingsPanel';
import { REMEDIATION } from './helpers/remediationFixtures';
import { ApiError } from '../src/lib/api/errors';

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });


beforeEach(() => { jest.clearAllMocks(); });

describe('RemediationCard', () => {
  it('shows the stage, the fix version, cleared and remaining findings with their reasons', () => {
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByTestId('remediation-fix-version').textContent).toContain('1.4.3');
    expect(screen.getByLabelText('Cleared findings').textContent).toContain('openssl 3.0.1 → 3.0.2');
    const remaining = screen.getByLabelText('Remaining findings').textContent ?? '';
    expect(remaining).toContain('Fix is a new Go module major version');
    expect(remaining).toContain('Fix needs a bigger upgrade than allowed (needs a major upgrade)');
    expect(screen.getByLabelText('Why this fix waits for approval').textContent).toContain('declares no smokeTest');
  });

  it('approves only after a step-up, passing its token', async () => {
    api.approvePluginRemediation.mockReturnValue(ok({ ...REMEDIATION, stage: 'published' }));
    const onChanged = jest.fn<AnyFn>();
    render(<RemediationCard remediation={REMEDIATION} canWrite onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve and publish/ }));
    expect(api.approvePluginRemediation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(api.approvePluginRemediation).toHaveBeenCalledWith('rem-1', {}, 'step-up-token'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ stage: 'published' })));
  });

  it('rejects behind a step-up too', async () => {
    api.rejectPluginRemediation.mockReturnValue(ok({ ...REMEDIATION, stage: 'failed', outcome: 'rejected' }));
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(api.rejectPluginRemediation).toHaveBeenCalledWith('rem-1', {}, 'step-up-token'));
  });

  it('sends the optional reject reason from the step-up details', async () => {
    api.rejectPluginRemediation.mockReturnValue(ok({ ...REMEDIATION, stage: 'failed', outcome: 'rejected' }));
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
    const reason = screen.getByTestId('remediation-reject-reason') as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(1000);
    fireEvent.change(reason, { target: { value: '  breaks our arm64 build  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(api.rejectPluginRemediation).toHaveBeenCalledWith('rem-1', { reason: 'breaks our arm64 build' }, 'step-up-token'));
  });

  it('approve has no reason field; only reject does', () => {
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /Approve and publish/ }));
    expect(screen.queryByTestId('remediation-reject-reason')).toBeNull();
  });

  it('one busy state: while a decision runs, Approve and Reject are both disabled', async () => {
    let settle: (v: unknown) => void = () => undefined;
    api.approvePluginRemediation.mockReturnValue(new Promise((r) => { settle = r; }));
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /Approve and publish/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(api.approvePluginRemediation).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Approve and publish/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Reject/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }));
    expect(screen.queryByRole('dialog', { name: 'Reject this fix?' })).toBeNull();
    settle({ success: true, statusCode: 202, data: REMEDIATION });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Reject/ })).not.toBeDisabled());
    expect(screen.getByRole('button', { name: /Approve and publish/ })).not.toBeDisabled();
  });

  it('one busy state: a retry in flight disables Retry until it settles', async () => {
    let settle: (v: unknown) => void = () => undefined;
    api.retryPluginRemediation.mockReturnValue(new Promise((r) => { settle = r; }));
    render(<RemediationCard remediation={{ ...REMEDIATION, stage: 'failed' }} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /Retry remediation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry remediation/ })).toBeDisabled());
    settle({ success: true, statusCode: 202, data: { ...REMEDIATION, stage: 'queued' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry remediation/ })).not.toBeDisabled());
  });

  it('offers no second decision once a fix is approved and still publishing (the server answers 409)', () => {
    render(<RemediationCard remediation={{ ...REMEDIATION, decidedAt: '2026-11-19T02:00:00Z', decidedBy: 'u-1' }} canWrite />);
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(screen.getByTestId('remediation-fix-version').textContent).toContain('approved, publishing');
  });

  it('a fix whose from-version was purged stays readable (patch included) but offers no Approve or Retry', () => {
    const { unmount } = render(<RemediationCard remediation={{ ...REMEDIATION, pluginId: null, stage: 'needs_review' }} canWrite />);
    expect(screen.getByTestId('remediation-source-purged').textContent).toContain(`${REMEDIATION.pluginName} ${REMEDIATION.fromVersion} was purged`);
    expect(screen.queryByRole('button', { name: /Retry remediation/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Show patch/ })).toBeTruthy();
    unmount();
    render(<RemediationCard remediation={{ ...REMEDIATION, pluginId: null }} canWrite />);
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
  });

  it('hides Approve and Reject without plugins:write', () => {
    render(<RemediationCard remediation={REMEDIATION} canWrite={false} />);
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
  });

  it('loads the patch on demand and renders it as a diff', async () => {
    api.getPluginRemediationPatch.mockReturnValue(Promise.resolve('--- a/Dockerfile\n+++ b/Dockerfile\n-RUN apt-get install openssl\n+RUN apt-get install openssl=3.0.2\n'));
    render(<RemediationCard remediation={REMEDIATION} canWrite />);
    expect(api.getPluginRemediationPatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Show patch/ }));
    const diff = await screen.findByTestId('remediation-patch');
    expect(api.getPluginRemediationPatch).toHaveBeenCalledWith('rem-1');
    expect(diff.textContent).toContain('+RUN apt-get install openssl=3.0.2');
  });

  it('offers Retry for a failed remediation and shows its error code and rollout', async () => {
    api.retryPluginRemediation.mockReturnValue(ok({ ...REMEDIATION, id: 'rem-2', stage: 'queued', attempt: 2 }));
    render(<RemediationCard
      remediation={{
        ...REMEDIATION, stage: 'needs_review', error: 'SOURCE_CHECKSUM_MISMATCH',
        rollout: {
          status: 'paused', toVersion: '1.4.3', pausedReason: 'rollbacks', updatedAt: '2026-11-19T02:00:00Z',
          waves: [{ index: 0, kind: 'canary', pipelineIds: ['pipe-1', 'pipe-2'], startedAt: '2026-11-19T01:00:00Z', finishedAt: null, outcome: 'failed' }],
          counts: { eligible: 9, proposed: 0, changeRequested: 0, moved: 2, failed: 0, rolledBack: 2, skippedOptOut: 1, skippedRunner: 0 },
        },
        rolledBackPipelineIds: ['pipe-1', 'pipe-9'],
      }}
      canWrite
    />);
    expect(screen.getByTestId('remediation-error').textContent).toContain('SOURCE_CHECKSUM_MISMATCH');
    expect(screen.getByTestId('remediation-rollout').textContent).toContain('2/9 pipelines moved');
    expect(screen.getByTestId('remediation-rollout').textContent).toContain('1 opted out');
    expect(screen.getByTestId('remediation-pipelines').querySelectorAll('a')).toHaveLength(2);
    // The pipelines moved back are linked by name of the remediation, not only counted.
    const rolledBack = screen.getByTestId('remediation-rolled-back');
    expect(rolledBack.textContent).toContain('Rolled back');
    expect([...rolledBack.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/dashboard/pipelines/pipe-1', '/dashboard/pipelines/pipe-9']);
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry remediation/ }));
    // Retry steps up like approve and reject: nothing is sent before the password.
    expect(api.retryPluginRemediation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    await waitFor(() => expect(api.retryPluginRemediation).toHaveBeenCalledWith('rem-1', 'step-up-token'));
  });

  it('shows the rollout\'s waiting-on-a-change-request and pending-redeploy counts when present', () => {
    render(<RemediationCard
      remediation={{
        ...REMEDIATION, stage: 'rolling_out',
        rollout: {
          status: 'batches', toVersion: '1.4.3', updatedAt: '2026-11-19T02:00:00Z', waves: [],
          counts: { eligible: 9, proposed: 0, changeRequested: 0, moved: 2, failed: 0, rolledBack: 0, skippedOptOut: 0, skippedRunner: 0, waitingChangeRequest: 3, movedPendingRedeploy: 1 },
        },
      }}
      canWrite
    />);
    const text = screen.getByTestId('remediation-rollout').textContent ?? '';
    expect(text).toContain('3 waiting on another change request');
    expect(text).toContain('1 moved, redeploy pending');
  });

  it('says the organization turned remediation off when approve or retry answers PLUGIN_REMEDIATION_MODE_OFF', async () => {
    api.retryPluginRemediation.mockRejectedValue(new ApiError('Plugin remediation is turned off for this organization', 409, 'PLUGIN_REMEDIATION_MODE_OFF'));
    render(<RemediationCard remediation={{ ...REMEDIATION, stage: 'failed' }} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: /Retry remediation/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm password' }));
    expect(await screen.findByText('Remediation is turned off for this organization')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['approve', /Approve and publish/, 'approvePluginRemediation', REMEDIATION],
    ['reject', /^Reject/, 'rejectPluginRemediation', REMEDIATION],
    ['retry', /Retry remediation/, 'retryPluginRemediation', { ...REMEDIATION, stage: 'failed' as const }],
  ])('a 503 on %s (operator turned remediation off) shows the operator-off notice, not a generic error', async (_k, button, fn, rem) => {
    (api as Record<string, jest.Mock<AnyFn>>)[fn].mockRejectedValue(new ApiError('Plugin remediation is turned off by the operator', 503, 'SERVICE_UNAVAILABLE'));
    render(<RemediationCard remediation={rem} canWrite />);
    fireEvent.click(screen.getByRole('button', { name: button }));
    const confirm = screen.queryByRole('button', { name: 'Confirm password' });
    if (confirm) fireEvent.click(confirm);
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('offers the Official export only in the system org', () => {
    const { rerender } = render(<RemediationCard remediation={{ ...REMEDIATION, hasExport: true }} canWrite />);
    expect(screen.queryByRole('button', { name: /Download patch for deploy\/plugins/ })).toBeNull();
    rerender(<RemediationCard remediation={{ ...REMEDIATION, hasExport: true }} canWrite isSystemOrg />);
    expect(screen.getByRole('button', { name: /Download patch for deploy\/plugins/ })).toBeTruthy();
  });
});

describe('RemediationsPanel', () => {
  it('links a row to its from-version only while that version is stored', async () => {
    api.listPluginRemediations.mockReturnValue(ok({
      remediations: [{ ...REMEDIATION, id: 'rem-kept' }, { ...REMEDIATION, id: 'rem-purged', pluginId: null }],
      nextCursor: null, enabled: true, severities: ['critical', 'high'], usedToday: 0, maxPerDay: 20,
    }));
    const onOpenPlugin = jest.fn<AnyFn>();
    render(<RemediationsPanel canWrite onOpenPlugin={onOpenPlugin} />);
    const kept = await screen.findByTestId('remediation-row-rem-kept');
    fireEvent.click(kept.querySelector('button.action-link') as HTMLElement);
    expect(onOpenPlugin).toHaveBeenCalledWith(REMEDIATION.pluginId);
    expect(screen.getByTestId('remediation-row-rem-purged').textContent).not.toContain('Open plugin');
  });
});

describe('PluginRemediationSection', () => {
  it('shows the newest remediation of the version', async () => {
    api.listPluginRemediations.mockReturnValue(ok({ remediations: [REMEDIATION], nextCursor: null, enabled: true, severities: ['critical', 'high'], usedToday: 1, maxPerDay: 20 }));
    render(<PluginRemediationSection pluginId="p-1" canWrite />);
    expect(await screen.findByTestId('remediation-card')).toBeTruthy();
    expect(api.listPluginRemediations).toHaveBeenCalledWith({ pluginId: 'p-1', limit: 1 }, expect.anything());
  });

  it('says plainly when the operator turned remediation off', async () => {
    api.listPluginRemediations.mockReturnValue(ok({ remediations: [], nextCursor: null, enabled: false, severities: [], usedToday: 0, maxPerDay: 20 }));
    render(<PluginRemediationSection pluginId="p-1" canWrite />);
    expect(await screen.findByText('Remediation is turned off by the operator')).toBeTruthy();
  });
});

describe('PluginFindingsPanel package details', () => {
  it('shows each finding\'s package type, location and layer, and the major / not-patchable markers', async () => {
    api.getPluginFindings.mockReturnValue(ok({
      plugin: { source: 'org', id: 'p-1', orgId: 'o', publisher: null, name: 'x', version: '1.0.0', imageDigest: null },
      summary: { critical: 2, high: 1 },
      findings: [
        { id: 'CVE-A', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', packageType: 'deb', purl: 'pkg:deb/debian/openssl@3.0.1', locations: [{ path: '/var/lib/dpkg/status', layerID: 'sha256:0123456789abcdef9999' }], fixedIn: ['3.0.2'], waived: false },
        { id: 'CVE-B', severity: 'critical', packageName: 'lodash', packageVersion: '4.17.0', packageType: 'npm', purl: 'pkg:npm/lodash@4.17.0', locations: [{ path: '/app/node_modules/lodash/package.json', layerID: 'sha256:app' }], fixedIn: ['5.0.0'], waived: false },
        { id: 'CVE-C', severity: 'high', packageName: 'serde', packageVersion: '1.0.0', packageType: 'rust-crate', purl: 'pkg:cargo/serde@1.0.0', locations: [], fixedIn: ['1.0.1'], waived: false },
        { id: 'CVE-D', severity: 'high', packageName: 'conan-thing', packageVersion: '1.0.0', packageType: 'other', purl: 'pkg:conan/thing@1.0.0', locations: [], fixedIn: ['1.0.1'], waived: false },
      ],
    }));
    render(<PluginFindingsPanel pluginId="p-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Show all findings/ }));
    await screen.findByTestId('findings-table');
    const cells = screen.getAllByTestId('finding-location').map((c) => c.textContent ?? '');
    expect(cells[0]).toContain('Debian package');
    expect(cells[0]).toContain('/var/lib/dpkg/status · layer sha256:0123456789ab');
    expect(screen.getAllByTestId('finding-marker-major')).toHaveLength(1);
    // A crate patches in source (not marked); an uncatalogued type has no patcher and no overlay.
    expect(screen.getAllByTestId('finding-marker-not-patchable')).toHaveLength(1);
  });
});
