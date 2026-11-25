// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings → Organization → Pipeline runners → Signing key card.
 *
 *  - Every state in the plan's table: no runners yet (Generate), active
 *    (Rotate, over-age badge), rotation pending (Cancel), overlap (Finish now
 *    only once the old key's time has passed), read-only viewers (status lines,
 *    no actions), inherit mode ("Inherited from …", Use our own key), own mode
 *    in a team (Inherit from …), "Used by N teams", unreadable (no actions).
 *  - Each action opens the panel's ONE step-up dialog with its copy and sends
 *    the token; revoke also needs the last 6 characters of the key id typed.
 *  - A rotation or switch in progress refetches every 60 s.
 *  - A key write refused by the per-org limit says so.
 *  - Only key ids and dates are shown (the DTO carries nothing else).
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { RunnerSigningKeyDto, RunnerSigningKeySummary } from '@pipeline-builder/api-core/pipeline-runners';
import { PipelineRunnersSettings, KEY_WRITE_RATE_LIMIT_COPY } from '../src/components/settings/PipelineRunnersSettings';
import { RunnerSigningKeyCard, SIGNING_KEY_REFETCH_MS } from '../src/components/settings/RunnerSigningKeyCard';
import { ApiError } from '../src/lib/api/errors';
import type { PipelineRunner, PipelineRunnersDto } from '../src/lib/api/domains/pipelines';
import { pageToast } from './helpers/pageMocks';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed, onClose, details, title, confirmDisabledReason }: {
    onConfirmed: (t: string) => Promise<void> | void; onClose: () => void; details?: React.ReactNode; title?: string;
    confirmDisabledReason?: string | null;
  }) => (
    <div data-testid="stepup-modal">
      <h2>{title}</h2>
      {details}
      {confirmDisabledReason && <p data-testid="stepup-blocked">{confirmDisabledReason}</p>}
      <button type="button" disabled={!!confirmDisabledReason} onClick={async () => { await onConfirmed('tok'); onClose(); }}>Confirm step-up</button>
      <button type="button" onClick={onClose}>Cancel step-up</button>
    </div>
  ),
}));

const api = {
  getPipelineRunners: jest.fn<AnyFn>(),
  generateRunnerSigningKey: jest.fn<AnyFn>(),
  rotateRunnerSigningKey: jest.fn<AnyFn>(),
  cancelRunnerSigningKeyRotation: jest.fn<AnyFn>(),
  finishRunnerSigningKeyRotation: jest.fn<AnyFn>(),
  revokeRunnerSigningKey: jest.fn<AnyFn>(),
  setRunnerSigningKeyMode: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as Record<string, AnyFn>)[k]?.(...a) }),
}));

const KID = 'kid-active-0123456789abcdefXYZ123';
const NEXT_KID = 'kid-next-aaaaaaaaaaaaaaaaaaaa';
const OLD_KID = 'kid-old-bbbbbbbbbbbbbbbbbbbbbb';

const summary = (over: Partial<RunnerSigningKeySummary> = {}): RunnerSigningKeySummary => ({
  kid: KID, state: 'active', createdAt: '2026-01-01T00:00:00Z', createdBy: 'u1', activatesAt: '2026-01-01T00:00:00Z',
  retireAfter: null, ageDays: 40, ...over,
});
const key = (over: Partial<RunnerSigningKeyDto> = {}): RunnerSigningKeyDto => ({
  mode: 'own', isRootOrg: true, active: summary(), next: null, retiring: null, rotation: 'none',
  inheritedFrom: null, inheritingTeams: 0, inheritingTeamNames: [], inheritingRunners: 1, transition: null,
  unreadable: false, maxAgeDays: 365, ...over,
});
const runner = (): PipelineRunner => ({
  id: 'r1', orgId: 'org-1', label: 'Production', functionUrl: null, shareWithTeams: false, version: '1.2.0', regions: ['us-east-1'],
  health: 'healthy', status: 'active', lastDeliveryAt: null, createdAt: '2026-11-01T00:00:00Z', updateRequired: false,
  jwksUrl: 'https://pb.example.com/api/pipelines/runner/runners/r1/jwks.json', pipelineCount: 0,
  capabilities: [], shareDeploysWithTeams: false, pipelinePrefixes: [],
});
const dto = (signingKey: RunnerSigningKeyDto | null, over: Partial<PipelineRunnersDto> = {}): PipelineRunnersDto => ({
  available: true, unavailableReason: null, platformEgressIps: null, own: [runner()], inherited: [], signingKey, ...over,
});
const ok = (data: unknown) => ({ success: true, data });

beforeEach(() => {
  jest.clearAllMocks();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getPipelineRunners.mockResolvedValue(ok(dto(key())));
  for (const fn of [api.generateRunnerSigningKey, api.rotateRunnerSigningKey, api.cancelRunnerSigningKeyRotation,
    api.finishRunnerSigningKeyRotation, api.revokeRunnerSigningKey, api.setRunnerSigningKeyMode]) fn.mockResolvedValue(ok(key()));
});

const card = () => screen.findByTestId('runner-signing-key');
const dialog = () => screen.getByTestId('stepup-modal');
const confirmStepUp = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Confirm step-up' }));
const renderPanel = (props: { readOnly?: boolean; parentOrgName?: string } = {}) => render(<PipelineRunnersSettings orgId="org-1" {...props} />);

describe('Signing key card — states', () => {
  it('sits at the top of the panel, above the runner list', async () => {
    renderPanel();
    const c = await card();
    const all = [...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
    expect(all.indexOf('runner-signing-key')).toBeLessThan(all.indexOf('runner-r1'));
    expect(c).toBeInTheDocument();
  });

  it('no runners yet: says the first runner creates the key, and offers Generate key', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ active: null }), { own: [] })));
    renderPanel();
    const c = await card();
    expect(within(c).getByTestId('key-none')).toHaveTextContent('A signing key is created when you register your first runner.');
    expect(within(c).getByRole('button', { name: 'Generate key' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Rotate key' })).not.toBeInTheDocument();
  });

  it('active: the copyable key id, created date and by whom, its age, and Rotate key', async () => {
    renderPanel();
    const c = await card();
    const active = within(c).getByTestId('key-active');
    expect(active).toHaveTextContent(KID);
    expect(within(active).getByRole('button', { name: 'Copy the active key id' })).toBeInTheDocument();
    expect(active).toHaveTextContent(/Created .* by u1 · 40 days old/);
    expect(within(c).getByRole('button', { name: 'Rotate key' })).toBeInTheDocument();
    expect(within(c).queryByTestId('key-over-age')).not.toBeInTheDocument();
    // Revoke lives in a danger zone, collapsed by default.
    const danger = within(c).getByTestId('key-danger-zone');
    expect(danger.querySelector('details')).not.toHaveAttribute('open');
  });

  it('over age: the "Key is N days old, consider rotating" badge next to Rotate key', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ active: summary({ ageDays: 380 }) }))));
    renderPanel();
    expect(within(await card()).getByTestId('key-over-age')).toHaveTextContent('Key is 380 days old, consider rotating');
  });

  it('rotation pending: the new key id, when it starts signing (local time), and Cancel rotation', async () => {
    const at = '2026-11-19T09:42:00Z';
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'pending', next: summary({ kid: NEXT_KID, state: 'next', activatesAt: at, ageDays: 0 }) }))));
    renderPanel();
    const c = await card();
    const next = within(c).getByTestId('key-next');
    expect(next).toHaveTextContent(NEXT_KID);
    const local = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(next).toHaveTextContent(`Starts signing around ${local}`);
    expect(within(c).getByRole('button', { name: 'Cancel rotation' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Rotate key' })).not.toBeInTheDocument();
  });

  it('rotation overlap: active and retiring ids, "Old key removed at …", Finish now disabled until then', async () => {
    const later = new Date(Date.now() + 30 * 60_000).toISOString();
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'overlap', retiring: summary({ kid: OLD_KID, state: 'retiring', retireAfter: later }) }))));
    renderPanel();
    const c = await card();
    expect(within(c).getByTestId('key-active')).toHaveTextContent(KID);
    const retiring = within(c).getByTestId('key-retiring');
    expect(retiring).toHaveTextContent(OLD_KID);
    expect(retiring).toHaveTextContent(`Old key removed at ${new Date(later).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    const finish = within(c).getByRole('button', { name: 'Finish now' });
    expect(finish.hasAttribute('disabled') || finish.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('rotation overlap past the retire time: Finish now is enabled', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'overlap', retiring: summary({ kid: OLD_KID, state: 'retiring', retireAfter: past }) }))));
    renderPanel();
    const finish = within(await card()).getByRole('button', { name: 'Finish now' });
    expect(finish).not.toBeDisabled();
    expect(finish).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('read-only viewers see the same status lines and no actions', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'pending', next: summary({ kid: NEXT_KID, state: 'next', ageDays: 0 }) }))));
    renderPanel({ readOnly: true });
    const c = await card();
    expect(within(c).getByTestId('key-active')).toHaveTextContent(KID);
    expect(within(c).getByTestId('key-next')).toHaveTextContent(NEXT_KID);
    const actions = within(c).queryAllByRole('button').filter((b) => !/^Copy /.test(b.getAttribute('aria-label') ?? ''));
    expect(actions).toHaveLength(0);
    expect(within(c).queryByTestId('key-danger-zone')).not.toBeInTheDocument();
  });

  it('inherit mode: "Inherited from <parent>" with its active key id and rotation, read-only, plus Use our own key', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({
      mode: 'inherit', isRootOrg: false, active: null,
      inheritedFrom: { orgId: 'root', orgName: 'Acme Corp', activeKid: 'kid-parent-1234567890', rotation: 'pending' },
    }))));
    renderPanel();
    const c = await card();
    expect(within(c).getByTestId('key-inherited-from')).toHaveTextContent('Inherited from Acme Corp');
    expect(c).toHaveTextContent('kid-parent-1234567890');
    expect(within(c).getByTestId('key-inherited-rotation')).toHaveTextContent(/Acme Corp is rotating its key/);
    for (const name of ['Rotate key', 'Generate key', 'Revoke key']) expect(within(c).queryByRole('button', { name })).not.toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Use our own key' })).toBeInTheDocument();
  });

  it('own mode in a team: the states above plus "Inherit from <parent>"', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ isRootOrg: false }))));
    renderPanel({ parentOrgName: 'Acme Corp' });
    const c = await card();
    expect(within(c).getByRole('button', { name: 'Rotate key' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Inherit from Acme Corp' })).toBeInTheDocument();
  });

  it('a root org has no mode switch', async () => {
    renderPanel();
    const c = await card();
    expect(within(c).queryByRole('button', { name: /^Inherit from/ })).not.toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: 'Use our own key' })).not.toBeInTheDocument();
  });

  it('a parent\'s card says "Used by N teams"', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ inheritingTeams: 3, inheritingTeamNames: ['Payments', 'Search', 'Web'] }))));
    renderPanel();
    expect(within(await card()).getByTestId('key-used-by-teams')).toHaveTextContent('Used by 3 teams');
  });

  it('unreadable: the operator message and no actions at all', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ unreadable: true }))));
    renderPanel();
    const c = await card();
    expect(c).toHaveTextContent("Your signing key can't be read.");
    expect(within(c).getByTestId('key-unreadable')).toHaveTextContent('Runs through your runners are paused until your platform operator fixes it.');
    expect(within(c).queryAllByRole('button')).toHaveLength(0);
  });

  it('renders nothing while runners are unavailable (no signingKey)', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(null, { available: false, unavailableReason: 'paused' })));
    const { container } = renderPanel();
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('Signing key card — writes, each through the panel\'s step-up dialog', () => {
  it('Generate: the dialog copy, then POST with the token, a toast and a re-read', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ active: null }), { own: [] })));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Generate key' }));
    expect(dialog()).toHaveTextContent('Your runners will verify requests with a key only this organization uses. Nothing changes in your AWS account.');
    expect(api.generateRunnerSigningKey).not.toHaveBeenCalled();
    confirmStepUp();
    await waitFor(() => expect(api.generateRunnerSigningKey).toHaveBeenCalledWith('tok'));
    await waitFor(() => expect(api.getPipelineRunners).toHaveBeenCalledTimes(2));
    expect(pageToast.success).toHaveBeenCalledWith('Signing key generated');
  });

  it('Rotate: the dialog copy, naming the teams that inherit the key', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ inheritingTeams: 2, inheritingTeamNames: ['Payments', 'Search'], inheritingRunners: 5 }))));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Rotate key' }));
    expect(dialog()).toHaveTextContent('A new key is published now and starts signing in 10 minutes. The old key stays valid for 1 hour after that.');
    expect(within(dialog()).getByTestId('key-dialog-teams')).toHaveTextContent('2 teams that inherit it: Payments, Search (5 runners in all)');
    confirmStepUp();
    await waitFor(() => expect(api.rotateRunnerSigningKey).toHaveBeenCalledWith('tok'));
  });

  it('Cancel rotation: DELETE through the step-up', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'pending', next: summary({ kid: NEXT_KID, state: 'next', ageDays: 0 }) }))));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Cancel rotation' }));
    confirmStepUp();
    await waitFor(() => expect(api.cancelRunnerSigningKeyRotation).toHaveBeenCalledWith('tok'));
  });

  it('Finish now: POST …/finish through the step-up', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ rotation: 'overlap', retiring: summary({ kid: OLD_KID, state: 'retiring', retireAfter: new Date(Date.now() - 1000).toISOString() }) }))));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Finish now' }));
    confirmStepUp();
    await waitFor(() => expect(api.finishRunnerSigningKeyRotation).toHaveBeenCalledWith('tok'));
  });

  it('Revoke: the danger-zone copy, and confirm stays disabled until the last 6 characters of the key id are typed', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ inheritingTeams: 1, inheritingTeamNames: ['Payments'] }))));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Revoke key' }));
    expect(dialog()).toHaveTextContent('Requests already signed with this key will be refused and retried with the new one.');
    const confirm = within(dialog()).getByRole('button', { name: 'Confirm step-up' });
    expect(confirm).toBeDisabled();
    const field = within(dialog()).getByTestId('key-revoke-confirm');
    fireEvent.change(field, { target: { value: 'wrong!' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(api.revokeRunnerSigningKey).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: KID.slice(-6) } });
    expect(confirm).not.toBeDisabled();
    confirmStepUp();
    await waitFor(() => expect(api.revokeRunnerSigningKey).toHaveBeenCalledWith(KID.slice(-6), 'tok'));
  });

  it('Use our own key: PUT mode own through the step-up', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({
      mode: 'inherit', isRootOrg: false, active: null,
      inheritedFrom: { orgId: 'root', orgName: 'Acme Corp', activeKid: 'kid-parent', rotation: 'none' },
    }))));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Use our own key' }));
    expect(dialog()).toHaveTextContent(/starts signing in 10 minutes/);
    expect(dialog()).toHaveTextContent('Runners Acme Corp shares with you keep using its key.');
    confirmStepUp();
    await waitFor(() => expect(api.setRunnerSigningKeyMode).toHaveBeenCalledWith('own', 'tok'));
  });

  it('Inherit from <parent>: PUT mode inherit through the step-up', async () => {
    api.getPipelineRunners.mockResolvedValue(ok(dto(key({ isRootOrg: false }))));
    renderPanel({ parentOrgName: 'Acme Corp' });
    fireEvent.click(within(await card()).getByRole('button', { name: 'Inherit from Acme Corp' }));
    expect(dialog()).toHaveTextContent("Acme Corp's keys are published for your runners now");
    confirmStepUp();
    await waitFor(() => expect(api.setRunnerSigningKeyMode).toHaveBeenCalledWith('inherit', 'tok'));
  });

  it('a key write refused by the per-org limit (429) says so', async () => {
    api.rotateRunnerSigningKey.mockRejectedValue(new ApiError('Too many requests', 429, 'RATE_LIMITED'));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Rotate key' }));
    confirmStepUp();
    expect(await screen.findByText(KEY_WRITE_RATE_LIMIT_COPY)).toBeInTheDocument();
  });

  it('a runner-key refusal gets its copy (RUNNER_KEY_TRANSITION_IN_PROGRESS)', async () => {
    api.rotateRunnerSigningKey.mockRejectedValue(new ApiError('busy', 409, 'RUNNER_KEY_TRANSITION_IN_PROGRESS'));
    renderPanel();
    fireEvent.click(within(await card()).getByRole('button', { name: 'Rotate key' }));
    confirmStepUp();
    expect(await screen.findByText(/A key rotation or key-mode change is already in progress/)).toBeInTheDocument();
  });
});

describe('Signing key card — refetch during a rotation or switch', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  const advance = async (ms: number) => { await act(async () => { await jest.advanceTimersByTimeAsync(ms); }); };

  it('refetches every 60 s while a rotation is pending', async () => {
    const onRefetch = jest.fn<AnyFn>();
    render(<RunnerSigningKeyCard signingKey={key({ rotation: 'pending', next: summary({ kid: NEXT_KID, state: 'next', ageDays: 0 }) })}
      readOnly={false} locked={false} hasRunners onWrite={() => {}} onRefetch={onRefetch} />);
    expect(onRefetch).not.toHaveBeenCalled();
    await advance(SIGNING_KEY_REFETCH_MS);
    expect(onRefetch).toHaveBeenCalledTimes(1);
    await advance(SIGNING_KEY_REFETCH_MS);
    expect(onRefetch).toHaveBeenCalledTimes(2);
    expect(SIGNING_KEY_REFETCH_MS).toBe(60_000);
  });

  it('refetches during a key-mode switch', async () => {
    const onRefetch = jest.fn<AnyFn>();
    render(<RunnerSigningKeyCard signingKey={key({ isRootOrg: false, transition: { kind: 'to_inherit', switchAt: '2026-11-19T10:00:00Z', until: '2026-11-19T11:00:00Z' } })}
      readOnly={false} locked={false} hasRunners onWrite={() => {}} onRefetch={onRefetch} />);
    expect(screen.getByTestId('key-transition')).toHaveTextContent(/Switching to/);
    await advance(SIGNING_KEY_REFETCH_MS);
    expect(onRefetch).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when nothing is in progress', async () => {
    const onRefetch = jest.fn<AnyFn>();
    render(<RunnerSigningKeyCard signingKey={key()} readOnly={false} locked={false} hasRunners onWrite={() => {}} onRefetch={onRefetch} />);
    await advance(3 * SIGNING_KEY_REFETCH_MS);
    expect(onRefetch).not.toHaveBeenCalled();
  });
});
