// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's plugin security in the dashboard. Vulnerability state never
 * blocks a pipeline, so every surface here grades, notifies or remediates:
 *  - the Plugin security tab: overall severity, per-step grades + scan facts,
 *    exposures with triage (accept with reason + date ≤ 90 days, the KEV
 *    acknowledgement only when relevant; false positive; reopen), read-only
 *    viewers see the actions disabled;
 *  - the upgrade panel: preview → choose steps / widen / redeploy → apply, and
 *    the versions the move frees for deletion;
 *  - the pipeline's own artifact security reports;
 *  - a plugin delete refused because pipelines still use the version;
 *  - the Ecosystem console's kept setup images (promote, and a 409's findings);
 *  - the pure helpers (acceptance window, triage body, save-warning toast).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

const api = {
  getPipelineSecurity: jest.fn<AnyFn>(),
  listPipelineExposures: jest.fn<AnyFn>(),
  triagePipelineExposure: jest.fn<AnyFn>(),
  previewPluginUpgrades: jest.fn<AnyFn>(),
  applyPluginUpgrades: jest.fn<AnyFn>(),
  getPipelineSecurityReports: jest.fn<AnyFn>(),
  listKeptSetupImages: jest.fn<AnyFn>(),
  promoteKeptSetupImage: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { PipelineSecurityTab } from '../src/components/pipeline/security/PipelineSecurityTab';
import { PluginUpgradePanel } from '../src/components/pipeline/security/PluginUpgradePanel';
import { ArtifactSecurityReportsCard } from '../src/components/pipeline/security/ArtifactSecurityReportsCard';
import { PluginInUseModal, pluginInUseRefusal } from '../src/components/plugin/PluginInUseModal';
import { KeptSetupImagesPanel } from '../src/components/ecosystem/KeptSetupImagesPanel';
import { ApiError } from '../src/lib/api/errors';
import {
  acceptedUntilIso, acceptanceWindow, pluginWarningsToast, toolchainChangeRunId, triageBody, triageProblem,
} from '../src/lib/pipeline-security';
import { shortDigest } from '../src/lib/format';

const ok = <T,>(data: T) => Promise.resolve({ success: true, data });

const EXPOSURE = {
  id: 'e1', pipelineId: 'p1', plugin: 'acme/trivy', pluginPublisher: 'acme', pluginName: 'trivy', version: '1.4.0',
  imageDigest: 'sha256:abcdef1234567890', source: 'declared', criticalCount: 2, highCount: 1,
  topFindings: [{ id: 'CVE-2026-0001', severity: 'critical', kev: true }], findingCount: 3, triageState: 'open',
  acceptance: null, triageReason: null, triagedBy: null, triagedAt: null, flaggedAt: '2026-10-01T00:00:00Z', fixedAt: null,
};

const SECURITY = {
  pipeline: { id: 'p1', name: 'web' },
  severity: 'critical',
  steps: [{
    stepKey: 'build/scan', plugin: 'acme/trivy', declaredVersion: '^1', version: '1.4.0', digest: 'sha256:abcdef1234567890',
    withinPolicy: true, resolutionComputedAt: null, lastLookupAt: '2026-10-30T00:00:00Z', warnings: [], refusal: null,
    catalogState: 'live',
    scan: { flagged: true, kev: 1, criticalFixable: 2, highFixable: 1, critical: 2, high: 1, scannedAt: '2026-10-30T00:00:00Z', stale: false, unscanned: false },
    severity: 'critical',
    currentWarnings: [
      { code: 'VULN_FLAGGED', severity: 'error', message: 'trivy@1.4.0 is flagged.' },
      { code: 'VULN_KEV', severity: 'critical', message: 'trivy@1.4.0 has a KEV finding.' },
    ],
    exposures: [EXPOSURE],
  }],
  buildImage: null,
  exposures: [EXPOSURE],
};

const BUILD_IMAGE = {
  stepKey: 'build-image', plugin: 'pipeline-bootstrap', releaseVersion: '1.4.2', digest: 'sha256:bbbbbbbbbbbbbbbbbbbb',
  imageRepository: 'system/pipeline-bootstrap', resolvedVia: 'pin', deployedAt: '2026-11-10T09:00:00Z', lastLookupAt: '2026-11-10T09:00:00Z',
  warnings: [{ code: 'TOOLCHAIN_RELEASE_DEPRECATED', message: 'Release 1.4.2 is deprecated.', severity: 'warning' }],
  refusal: null, catalogState: 'live',
  scan: { flagged: false, kev: 0, criticalFixable: 0, highFixable: 0, critical: 0, high: 1, scannedAt: '2026-11-09T00:00:00Z', stale: false, unscanned: false },
  severity: 'ok', currentWarnings: [], exposures: [],
  effectiveDefault: { releaseVersion: '1.5.0', resolvedVia: 'org-default' },
  behindDefault: true, synthPlugin: 'cdk-synth', toolchainUnmanaged: false,
  change: { from: '1.4.1', to: '1.4.2', changedAt: '2026-11-10T09:00:00Z' },
  releaseNotes: 'Bumps aws-cdk to 2.1150.0.',
};

const PREVIEW = {
  pipelineId: 'p1',
  upgrades: [
    {
      stepKey: 'build/scan', path: 'stages[0].steps[0]', plugin: 'acme/trivy', publisher: 'acme', declaredVersion: '^1', pin: 'range',
      currentVersion: '1.4.0', reason: { flagged: true, kev: 1, criticalFixable: 2, highFixable: 1 },
      suggestedInPin: '1.5.2', suggestedLatest: '2.0.0', apply: { version: '^1.5.2', widenVersion: '^2.0.0' },
    },
    {
      stepKey: 'deploy/lint', path: 'stages[1].steps[0]', plugin: 'eslint', publisher: null, declaredVersion: '3.0.0', pin: 'exact',
      currentVersion: '3.0.0', reason: { flagged: false, kev: 0, criticalFixable: 1, highFixable: 0 },
      suggestedInPin: null, suggestedLatest: '3.1.0', apply: { version: null, widenVersion: '3.1.0' },
    },
  ],
  releases: [{ plugin: 'acme/trivy', publisher: 'acme', version: '1.4.0', references: { declared: 0, deployed: 1 }, removable: false }],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.getPipelineSecurity.mockReturnValue(ok(SECURITY));
  api.getPipelineSecurityReports.mockReturnValue(ok({ pipelineId: 'p1', reports: [], counts: { critical: 0, high: 0, medium: 0, low: 0, kev: 0, criticalFixable: 0, highFixable: 0 }, latestAt: null }));
});

describe('pipeline-security helpers', () => {
  const now = new Date('2026-11-02T12:00:00Z');

  it('bounds the acceptance window to tomorrow … 90 days out, clamping a day past the server ceiling', () => {
    const w = acceptanceWindow(now);
    expect(w.min < w.max).toBe(true);
    expect(acceptedUntilIso('2026-11-02', now)).toBeNull(); // today 00:00Z is already past
    expect(acceptedUntilIso('2026-12-01', now)).toBe('2026-12-01T00:00:00.000Z');
    // 90 days + 1 → clamped inside the server's window, never over it.
    const clamped = Date.parse(acceptedUntilIso('2027-02-01', now)!);
    expect(clamped).toBeLessThanOrEqual(now.getTime() + 90 * 86_400_000);
    expect(acceptedUntilIso('nope', now)).toBeNull();
  });

  it('asks for a reason, a valid date and — only for KEV — the acknowledgement', () => {
    const base = { action: 'accept' as const, reason: 'fix scheduled', day: '2026-12-01', kevAck: false };
    expect(triageProblem({ ...base, reason: ' ' }, false, now)).toMatch(/needs a reason/);
    expect(triageProblem({ ...base, day: '2028-01-01' }, false, now)).toBeNull(); // clamped, still valid
    expect(triageProblem({ ...base, day: '2026-10-01' }, false, now)).toMatch(/Choose a date/);
    expect(triageProblem(base, true, now)).toMatch(/KEV/);
    expect(triageProblem({ ...base, kevAck: true }, true, now)).toBeNull();
    expect(triageProblem({ action: 'reopen', reason: '', day: '', kevAck: false }, true, now)).toBeNull();
    expect(triageBody({ ...base, kevAck: true }, true, now)).toEqual({ action: 'accept', reason: 'fix scheduled', acceptedUntil: '2026-12-01T00:00:00.000Z', kev: true });
    expect(triageBody(base, false, now)).not.toHaveProperty('kev');
    expect(triageBody({ action: 'false_positive', reason: ' n/a ', day: '', kevAck: false }, false, now)).toEqual({ action: 'false_positive', reason: 'n/a' });
  });

  it('turns save-time plugin warnings into a non-blocking toast graded by the loudest', () => {
    expect(pluginWarningsToast(undefined)).toBeNull();
    expect(pluginWarningsToast([{ severity: 'info', message: 'm' }])!.type).toBe('info');
    const t = pluginWarningsToast([
      { severity: 'warning', message: 'stale scan', stepKey: 'a' },
      { severity: 'critical', message: 'KEV finding', stepKey: 'b' },
    ])!;
    expect(t.type).toBe('warning');
    expect(t.message).toMatch(/2 plugin warnings \(loudest: critical\)/);
    expect(t.message).toMatch(/b: KEV finding/);
    expect(t.message).toMatch(/never block/);
    expect(shortDigest('sha256:abcdef1234567890')).toBe('abcdef123456');
  });
});

describe('toolchainChangeRunId (the run-history marker)', () => {
  const change = { from: '1.4.1', to: '1.4.2', changedAt: '2026-11-10T09:00:00Z' };
  const runs = [
    { execution_id: 'e3', started_at: '2026-11-11T00:00:00Z' },
    { execution_id: 'e2', started_at: '2026-11-10T09:05:00Z' },
    { execution_id: 'e1', started_at: '2026-11-09T00:00:00Z' },
    { execution_id: 'e0', started_at: null },
  ];

  it('marks only the FIRST run after the change, whatever the order', () => {
    expect(toolchainChangeRunId(runs, change)).toBe('e2');
    expect(toolchainChangeRunId([...runs].reverse(), change)).toBe('e2');
  });

  it('marks nothing without a change, or before any run has started since', () => {
    expect(toolchainChangeRunId(runs, null)).toBeNull();
    expect(toolchainChangeRunId(runs.filter((r) => r.execution_id === 'e1'), change)).toBeNull();
    expect(toolchainChangeRunId(null, change)).toBeNull();
    expect(toolchainChangeRunId(runs, { ...change, changedAt: 'nope' })).toBeNull();
  });
});

describe('PipelineSecurityTab', () => {
  it('shows the overall severity, each step graded with its scan facts, and the exposures', async () => {
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    const step = await screen.findByTestId('security-step-build/scan');
    expect(within(step).getByText('abcdef123456')).toBeInTheDocument();
    expect(within(step).getByText('1 KEV')).toBeInTheDocument();
    expect(within(step).getByText('Flagged by rescan')).toBeInTheDocument();
    const items = within(step).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-severity'))).toEqual(['critical', 'error']);
    expect(screen.getByTestId('exposure-e1')).toHaveTextContent('acme/trivy@1.4.0');
    expect(screen.queryByText(/blocked/i)).not.toBeInTheDocument();
  });

  it('shows the Build image row: release, digest, how it was chosen, scan, the build-image lookup warnings, behind the effective default and the last change', async () => {
    api.getPipelineSecurity.mockReturnValue(ok({ ...SECURITY, buildImage: BUILD_IMAGE }));
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    const row = await screen.findByTestId('security-build-image');
    expect(row).toHaveTextContent('pipeline-bootstrap@1.4.2');
    expect(within(row).getByText('bbbbbbbbbbbb')).toBeInTheDocument();
    expect(within(row).getByText('Pinned by this pipeline')).toBeInTheDocument();
    expect(within(row).getByTestId('build-image-behind')).toHaveTextContent('Behind default (1.5.0)');
    expect(within(row).queryByTestId('build-image-unmanaged')).not.toBeInTheDocument();
    expect(within(row).getByTestId('build-image-warning-toolchain_release_deprecated')).toHaveTextContent('deprecated');
    expect(within(row).getByText(/Crit 0\/0/)).toBeInTheDocument();
    expect(within(row).getByTestId('build-image-change')).toHaveTextContent('Toolchain 1.4.1 → 1.4.2');
    expect(within(row).getByText('Bumps aws-cdk to 2.1150.0.')).toBeInTheDocument();
    // Never listed as a step.
    expect(screen.queryByTestId('security-step-build-image')).not.toBeInTheDocument();
  });

  it('shows "toolchain unmanaged" for a custom synth, no "behind" on the effective default, and no row before anything is recorded', async () => {
    api.getPipelineSecurity.mockReturnValue(ok({ ...SECURITY, buildImage: { ...BUILD_IMAGE, behindDefault: false, toolchainUnmanaged: true, synthPlugin: 'my-synth', change: null, effectiveDefault: { releaseVersion: '1.4.2', resolvedVia: 'default' } } }));
    const { unmount } = render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    const row = await screen.findByTestId('security-build-image');
    expect(within(row).getByTestId('build-image-unmanaged')).toHaveTextContent('Toolchain unmanaged');
    expect(row).toHaveTextContent('my-synth');
    expect(within(row).queryByTestId('build-image-behind')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('build-image-change')).not.toBeInTheDocument();
    unmount();

    api.getPipelineSecurity.mockReturnValue(ok(SECURITY));
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    await screen.findByTestId('security-step-build/scan');
    expect(screen.queryByTestId('security-build-image')).not.toBeInTheDocument();
  });

  it('accepts a KEV exposure only with the explicit acknowledgement, a reason and a date', async () => {
    api.triagePipelineExposure.mockReturnValue(ok({ exposures: [] }));
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept risk' }));
    const form = screen.getByTestId('exposure-triage-form');
    const confirm = screen.getAllByRole('button', { name: 'Accept risk' }).at(-1)!;
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'compensating WAF rule' } });
    expect(confirm).toBeDisabled(); // KEV not acknowledged yet
    fireEvent.click(within(form).getByLabelText('Accept the known-exploited findings'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.triagePipelineExposure).toHaveBeenCalledWith('p1', 'e1', expect.objectContaining({
      action: 'accept', reason: 'compensating WAF rule', kev: true, acceptedUntil: expect.any(String),
    })));
    expect(toast.success).toHaveBeenCalled();
  });

  it('marks a false positive with a reason (no KEV question)', async () => {
    api.triagePipelineExposure.mockReturnValue(ok({ exposures: [] }));
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'False positive' }));
    const form = screen.getByTestId('exposure-triage-form');
    expect(within(form).queryByLabelText('Accept the known-exploited findings')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'not reachable' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark false positive' }));
    await waitFor(() => expect(api.triagePipelineExposure).toHaveBeenCalledWith('p1', 'e1', { action: 'false_positive', reason: 'not reachable' }));
  });

  it('shows the triage actions locked (disabled, with the reason) to a read-only viewer', async () => {
    render(<PipelineSecurityTab pipelineId="p1" canWrite={false} />);
    const accept = await screen.findByRole('button', { name: 'Accept risk' });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute('title', 'Requires pipelines:write');
  });

  it('loads closed exposures on request', async () => {
    api.listPipelineExposures.mockReturnValue(ok({ pipeline: { id: 'p1', name: 'web' }, exposures: [{ ...EXPOSURE, id: 'e2', fixedAt: '2026-10-20T00:00:00Z' }] }));
    render(<PipelineSecurityTab pipelineId="p1" canWrite />);
    fireEvent.click(await screen.findByLabelText('Show fixed exposures'));
    expect(await screen.findByTestId('exposure-e2')).toHaveTextContent('Fixed');
    expect(api.listPipelineExposures).toHaveBeenCalledWith('p1', { includeFixed: true }, expect.anything());
  });
});

describe('PluginUpgradePanel', () => {
  it('previews, applies the chosen steps with redeploy, and lists what the move frees', async () => {
    api.previewPluginUpgrades.mockReturnValue(ok(PREVIEW));
    api.applyPluginUpgrades.mockReturnValue(ok({
      upgraded: 1,
      results: [{
        pipelineId: 'p1', status: 'upgraded',
        applied: [{ stepKey: 'build/scan', plugin: 'acme/trivy', publisher: 'acme', fromVersion: '1.4.0', fromDeclared: '^1', toDeclared: '^1.5.2' }],
        pluginWarnings: [{ stepKey: 'build/scan', plugin: 'acme/trivy', code: 'SCAN_STALE', severity: 'warning', message: 'stale' }],
        redeploy: { executionId: 'exec-9' },
      }],
      releases: [{ plugin: 'acme/trivy', publisher: 'acme', version: '1.4.0', references: { declared: 0, deployed: 0 }, removable: true }],
      redeployRequired: false,
    }));
    const onApplied = jest.fn<AnyFn>();
    render(<PluginUpgradePanel pipelineId="p1" canWrite onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview upgrades' }));
    expect(await screen.findByLabelText('Upgrade build/scan')).toBeChecked();
    // Only widening reaches a clean version for the exact pin.
    expect(screen.getByLabelText('Upgrade deploy/lint')).toBeDisabled();
    expect(screen.getByText(/only by widening \(3\.1\.0\)/)).toBeInTheDocument();
    expect(screen.getByTestId('upgrade-releases')).toHaveTextContent('Still referenced: 0 declared · 1 deployed');
    fireEvent.click(screen.getByLabelText('Redeploy after upgrading'));
    fireEvent.click(screen.getByRole('button', { name: /apply 1 upgrade/i }));
    await waitFor(() => expect(api.applyPluginUpgrades).toHaveBeenCalledWith({ pipelineIds: ['p1'], widen: false, steps: ['build/scan'], redeploy: true }));
    const result = await screen.findByTestId('upgrade-result');
    expect(result).toHaveTextContent('^1.5.2');
    expect(result).toHaveTextContent('exec-9');
    expect(within(result).getByText('Removable')).toBeInTheDocument();
    expect(onApplied).toHaveBeenCalled();
  });

  it('re-previews with widen, and locks Apply without pipelines:write', async () => {
    api.previewPluginUpgrades.mockReturnValue(ok(PREVIEW));
    render(<PluginUpgradePanel pipelineId="p1" canWrite={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview upgrades' }));
    await screen.findByLabelText('Upgrade build/scan');
    fireEvent.click(screen.getByLabelText('Widen past the pin'));
    await waitFor(() => expect(api.previewPluginUpgrades).toHaveBeenLastCalledWith('p1', { widen: true }));
    await waitFor(() => expect(screen.getByLabelText('Upgrade deploy/lint')).toBeEnabled());
    const apply = screen.getByRole('button', { name: /apply 2 upgrades/i });
    expect(apply).toBeDisabled();
    expect(apply).toHaveAttribute('title', 'Requires pipelines:write');
  });
});

describe('ArtifactSecurityReportsCard', () => {
  it('lists the latest report per tool / stage with the summed counts', async () => {
    const counts = { critical: 1, high: 2, medium: 3, low: 4, kev: 1, criticalFixable: 1, highFixable: 1 };
    api.getPipelineSecurityReports.mockReturnValue(ok({
      pipelineId: 'p1',
      reports: [{ id: 'r1', pipelineId: 'p1', tool: 'grype', format: 'grype-json', stage: 'build', executionId: null, counts, findings: [{ id: 'CVE-2026-9' }], truncated: false, submittedBy: 'u1', createdAt: '2026-11-01T00:00:00Z' }],
      counts,
      latestAt: '2026-11-01T00:00:00Z',
    }));
    render(<ArtifactSecurityReportsCard pipelineId="p1" />);
    const table = await screen.findByTestId('artifact-security-reports');
    expect(table).toHaveTextContent('grype');
    expect(table).toHaveTextContent('CVE-2026-9');
    expect(within(table).getAllByText('1 KEV').length).toBeGreaterThan(0);
  });
});

describe('PluginInUseModal', () => {
  const err = new ApiError('trivy@1.4.0 is in use by 3 pipelines.', 409, 'PLUGIN_VERSION_IN_USE', {
    reason: 'in_use', pipelineCount: 3, orgCount: 2, severity: 'critical', suggestedVersion: '1.5.2',
    vulnerability: { flagged: true, kev: 1, criticalFixable: 2, highFixable: 1, critical: 2, high: 1 },
    pipelines: [{ id: 'p1', name: 'web', orgId: 'org-1', sources: ['declared'], deleted: false }],
  });

  it('recognises only the in-use refusal', () => {
    expect(pluginInUseRefusal(err, { name: 'trivy', version: '1.4.0' })).not.toBeNull();
    expect(pluginInUseRefusal(new ApiError('listed', 409, 'PLUGIN_VERSION_IN_USE', { reason: 'listed' }), { name: 'x', version: '1' })).toBeNull();
    expect(pluginInUseRefusal(new Error('x'), { name: 'x', version: '1' })).toBeNull();
  });

  it('names the pipelines with links to their upgrade, the severity and the suggested version', () => {
    render(<PluginInUseModal refusal={pluginInUseRefusal(err, { name: 'trivy', version: '1.4.0' })!} onClose={() => {}} />);
    const box = screen.getByTestId('plugin-in-use');
    expect(box).toHaveTextContent('3 pipelines still use it');
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('href', '/dashboard/pipelines/p1');
    expect(screen.getByRole('link', { name: /upgrade plugins/i })).toHaveAttribute('href', '/dashboard/pipelines/p1?tab=security');
    expect(screen.getByTestId('plugin-in-use-suggested')).toHaveTextContent('trivy@1.5.2');
    expect(box).toHaveTextContent('and 2 more pipelines in other organizations');
    expect(box).toHaveTextContent('Critical');
  });
});

describe('KeptSetupImagesPanel', () => {
  const IMG = {
    id: 'k1', pluginName: 'trivy', pluginVersion: '0.74.0', imageDigest: 'sha256:0123456789abcdef', imageSource: 'build',
    refusalCode: 'PLUGIN_VULN_GATE', refusalMessage: '2 fixable Critical', refusalFindings: [], visibility: 'public',
    publishRequest: false, keptBy: 'u1', keptAt: '2026-10-01T00:00:00Z', expiresAt: '2026-11-30T00:00:00Z',
  };

  it('promotes an image and shows the result', async () => {
    api.listKeptSetupImages.mockReturnValue(ok({ images: [IMG] }));
    api.promoteKeptSetupImage.mockReturnValue(ok({ plugin: { id: 'v1', name: 'trivy', version: '0.74.0', imageDigest: IMG.imageDigest }, messages: [{ level: 'WARN', message: 'waiver applied' }] }));
    render(<KeptSetupImagesPanel can={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Promote' }));
    expect(await screen.findByText('Promoted trivy@0.74.0')).toBeInTheDocument();
    expect(screen.getByText(/waiver applied/)).toBeInTheDocument();
    expect(api.promoteKeptSetupImage).toHaveBeenCalledWith('k1');
  });

  it('shows the findings a 409 says remain, and locks Promote without plugins:moderate', async () => {
    api.listKeptSetupImages.mockReturnValue(ok({ images: [IMG] }));
    api.promoteKeptSetupImage.mockRejectedValue(new ApiError('Still refused: 1 fixable Critical', 409, 'PLUGIN_VULN_GATE', {
      findings: [{ id: 'CVE-2026-7', severity: 'critical', packageName: 'openssl', packageVersion: '3.0.1', fixedIn: ['3.0.2'] }],
    }));
    const { unmount } = render(<KeptSetupImagesPanel can={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Promote' }));
    expect(await screen.findByText('Not promoted (PLUGIN_VULN_GATE)')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Remaining findings' })).toHaveTextContent('CVE-2026-7 (openssl@3.0.1 → 3.0.2)');
    unmount();
    render(<KeptSetupImagesPanel can={() => false} />);
    expect(await screen.findByRole('button', { name: 'Promote' })).toBeDisabled();
  });
});
