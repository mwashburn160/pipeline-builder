// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A pipeline's side of nightly plugin CVE remediation (Stage 3), on its Plugin
 * security tab: the Plugin security fixes election (with Apply greyed out when
 * the organization disallows it), open proposals with Apply / Dismiss, the
 * rollout waves, the rollback history, and the KEV banner for an opted-out
 * pipeline.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const toast = { success: jest.fn<AnyFn>(), error: jest.fn<AnyFn>(), warning: jest.fn<AnyFn>(), info: jest.fn<AnyFn>() };
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => toast));

const api = {
  getPipelineRemediationUpgrades: jest.fn<AnyFn>(),
  applyPipelineRemediationUpgrade: jest.fn<AnyFn>(),
  dismissPipelineRemediationUpgrade: jest.fn<AnyFn>(),
  updatePipeline: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => (api as Record<string, unknown>)[k] }) }));

import { RemediationUpgradesPanel, proposalFixText } from '../src/components/pipeline/security/RemediationUpgradesPanel';
import { ApiError } from '../src/lib/api/errors';

const ok = <T,>(data: T) => Promise.resolve({ success: true, data });

const ROW = {
  id: 'u1', orgId: 'org-1', remediationId: 'r1', pipelineId: 'p1', pluginName: 'terraform-plan', pluginPublisher: null,
  fromVersion: '1.4.2', toVersion: '1.4.3', mode: 'propose', state: 'proposed', wave: null, movedAt: null, runRequestId: null,
  rolledBackAt: null, rolledBackTo: null, error: null, createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z',
};

function answer(over: Record<string, unknown> = {}, upgrades: unknown[] = [ROW]) {
  return {
    election: 'inherit',
    effective: { mode: 'propose', source: 'root', orgDefault: 'propose', applyRefused: false },
    orgDefault: 'propose',
    allowPipelineApply: true,
    upgrades,
    ...over,
  };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  Object.values(toast).forEach((f) => f.mockReset());
  api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer()));
  api.updatePipeline.mockImplementation(() => ok({ pipeline: { id: 'p1' } }));
  api.applyPipelineRemediationUpgrade.mockImplementation(() => ok({ upgrade: { ...ROW, state: 'moved' } }));
  api.dismissPipelineRemediationUpgrade.mockImplementation(() => ok({ upgrade: { ...ROW, state: 'dismissed' } }));
});

const election = () => screen.getByLabelText('Plugin security fixes') as HTMLSelectElement;
const option = (value: string) => Array.from(election().options).find((o) => o.value === value)!;

describe('Plugin security fixes election', () => {
  it('shows the organization default and saves the pipeline election', async () => {
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    expect(await screen.findByTestId('remediation-org-default')).toHaveTextContent('Organization default: Propose (set by the organization)');
    expect(option('inherit').textContent).toBe('Follow organization (Propose)');
    expect(option('apply').disabled).toBe(false);

    fireEvent.change(election(), { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updatePipeline).toHaveBeenCalledWith('p1', { remediationUpgrades: 'off' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('greys out Apply when the organization disallows it, and says so', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({ allowPipelineApply: false })));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    await screen.findByTestId('remediation-org-default');
    expect(option('apply').disabled).toBe(true);
    expect(option('apply').textContent).toMatch(/not allowed by your organization/);
    expect(screen.getByTestId('remediation-org-default')).toHaveTextContent('does not let pipelines choose Apply');
  });

  it('keeps Apply available when the organization default is apply, even with pipeline apply disallowed', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({ allowPipelineApply: false, orgDefault: 'apply' })));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    await screen.findByTestId('remediation-org-default');
    expect(option('apply').disabled).toBe(false);
  });

  it('explains a refused apply and the 403 from the server', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({
      election: 'propose', effective: { mode: 'propose', source: 'pipeline', orgDefault: 'propose', applyRefused: true },
    })));
    api.updatePipeline.mockImplementation(() => Promise.reject(new ApiError('nope', 403, 'PIPELINE_REMEDIATION_APPLY_NOT_ALLOWED')));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    expect(await screen.findByTestId('remediation-apply-refused')).toBeInTheDocument();
    fireEvent.change(election(), { target: { value: 'inherit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/does not let pipelines choose Apply. Choose Propose or Off/)).toBeInTheDocument();
  });

  it('disables every write control without pipelines:write', async () => {
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite={false} />);
    await screen.findByTestId('remediation-org-default');
    expect(election().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  });
});

describe('remediation proposals, waves and rollbacks', () => {
  it('banners a proposal with its CVE count, and Apply / Dismiss call the API', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({}, [{ ...ROW, criticalCleared: 3 }])));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    expect(await screen.findByText('Plugin terraform-plan 1.4.3 fixes 3 Critical CVEs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.applyPipelineRemediationUpgrade).toHaveBeenCalledWith('p1', 'u1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(api.dismissPipelineRemediationUpgrade).toHaveBeenCalledWith('p1', 'u1'));
  });

  it('words a proposal without counts plainly', () => {
    expect(proposalFixText({ ...ROW } as never)).toBe('fixes known vulnerabilities in 1.4.2');
    expect(proposalFixText({ ...ROW, criticalCleared: 1, highCleared: 2 } as never)).toBe('fixes 1 Critical and 2 High CVEs');
    expect(proposalFixText({ ...ROW, advisoryIds: ['CVE-1'] } as never)).toBe('fixes 1 CVE');
  });

  it('shows a change request for an approval-gated install', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({}, [{ ...ROW, state: 'change_requested' }])));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    expect(await screen.findByTestId('remediation-change-request-u1')).toHaveTextContent('approval-gated install');
  });

  it('shows the rollout waves and the rollback history', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer({ effective: { mode: 'apply', source: 'root', orgDefault: 'apply', applyRefused: false }, orgDefault: 'apply' }, [
      { ...ROW, id: 'w0', state: 'moved', wave: 0, movedAt: '2026-11-19T01:00:00Z' },
      { ...ROW, id: 'w1', state: 'queued', wave: 1 },
      { ...ROW, id: 'sr', state: 'skipped_runner', wave: 1 },
      { ...ROW, id: 'rb', state: 'rolled_back', rolledBackAt: '2026-11-19T02:00:00Z', rolledBackTo: '1.4.2' },
      { ...ROW, id: 'bl', state: 'rollback_blocked' },
      { ...ROW, id: 'fl', state: 'failed', error: 'COMPLIANCE_BLOCKED' },
    ])));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite />);
    const waves = await screen.findByTestId('remediation-waves');
    expect(waves).toHaveTextContent('Canary wave');
    expect(waves).toHaveTextContent('Batch 1');
    expect(waves).toHaveTextContent('runner was unhealthy');
    const history = screen.getByTestId('remediation-rollbacks');
    expect(history).toHaveTextContent('moved back to 1.4.2');
    expect(history).toHaveTextContent('no longer live');
    expect(history).toHaveTextContent('Move failed: COMPLIANCE_BLOCKED');
  });
});

describe('KEV opt-out banner', () => {
  const optedOut = { election: 'off', effective: { mode: 'off', source: 'pipeline', orgDefault: 'propose', applyRefused: false } };

  it('names the opt-out and the fix version not used', async () => {
    api.getPipelineRemediationUpgrades.mockImplementation(() => ok(answer(optedOut, [{ ...ROW, state: 'skipped_opt_out', kev: true }])));
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite kevSteps={['terraform-plan@1.4.2']} />);
    const banner = await screen.findByTestId('kev-opt-out-banner');
    expect(banner).toHaveTextContent('set to Off');
    expect(banner).toHaveTextContent('terraform-plan@1.4.2 has a CISA KEV-listed finding');
    expect(banner).toHaveTextContent('Fixed version not used: terraform-plan 1.4.3');
  });

  it('is absent when the pipeline follows its organization', async () => {
    render(<RemediationUpgradesPanel pipelineId="p1" canWrite kevSteps={['terraform-plan@1.4.2']} />);
    await screen.findByTestId('remediation-org-default');
    expect(screen.queryByTestId('kev-opt-out-banner')).toBeNull();
  });
});
