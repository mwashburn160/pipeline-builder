// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The system org's plugin version Retention panel (Ecosystem console → Retention).
 *
 * The properties that matter:
 *   - every rule code reads as words, and an unknown one still reads;
 *   - reclaimable bytes are formatted, or "not measured" when the registry could
 *     not measure (null) or measured only part (incomplete);
 *   - deferred versions are labelled, from the flag or from a run's action;
 *   - without plugins:moderate the panel is LOCKED (shown, with what it needs),
 *     and nothing is fetched;
 *   - "Run a pass now" steps up, POSTs with the token, and shows what the run
 *     did; the scheduled switch being off does not block a manual run.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RetentionPanel } from '../src/components/ecosystem/RetentionPanel';
import { NAV_SECTIONS } from '../src/lib/nav';
import {
  deferredCount, fractionText, isDeferred, reclaimableText, retentionConfigText, retentionRuleLabel,
  retentionStateLabel, retentionTotalsLines, runAvailability, runOutcome,
} from '../src/lib/plugin-retention';
import type { RetentionReport } from '../src/types/plugin-retention';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, details, onConfirmed, onClose }: {
    action: string; details?: ReactNode; onConfirmed: (t: string) => Promise<void> | void; onClose: () => void;
  }) => (
    <div role="dialog" aria-label="step-up">
      <p>{action}</p>
      <div>{details}</div>
      <button type="button" onClick={async () => { await onConfirmed('step-up-token'); onClose(); }}>Confirm identity</button>
    </div>
  ),
}));

const fns = {
  getRetentionPlan: jest.fn<AnyFn>(),
  runRetentionPass: jest.fn<AnyFn>(),
};
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (fns as Record<string, (...x: unknown[]) => unknown>)[k](...a) }),
}));

const ok = (data: unknown) => Promise.resolve({ success: true, statusCode: 200, data });
const MEASURED = { measured: true, incomplete: false };

const report = (over: Partial<RetentionReport> = {}): RetentionReport => ({
  generatedAt: '2026-11-14T00:00:00Z',
  enabled: true,
  dryRun: true,
  keep: 3,
  noticeDays: 30,
  batch: 50,
  maxFraction: 0.5,
  plugins: [
    {
      name: 'eslint',
      listed: true,
      marginalBytes: 3 * 1024 * 1024,
      versions: [
        { version: '9.2.0', digest: 'sha256:aaaa1111bbbb2222cccc', state: 'keep', rule: 'newest_in_major', marginalBytes: 0 },
        { version: '9.1.0', digest: null, state: 'keep', rule: 'pipeline_reference', marginalBytes: 0 },
        { version: '9.0.0', digest: null, state: 'deprecate', rule: 'superseded_in_major', marginalBytes: 2 * 1024 * 1024, notifyOrgIds: ['org-a'] },
        { version: '8.9.0', digest: null, state: 'deprecate', rule: 'superseded_in_major', marginalBytes: 1024 * 1024, deferred: true },
        { version: '8.8.0', digest: null, state: 'yank', rule: 'superseded_in_major', marginalBytes: 0, deprecatedAt: '2026-10-01T00:00:00Z', yankAfter: '2026-10-31T00:00:00Z' },
        { version: '8.7.0', digest: null, state: 'reverse', rule: 'install_pinned', marginalBytes: 0, deprecatedAt: '2026-10-01T00:00:00Z' },
      ],
    },
    {
      name: 'jest',
      listed: false,
      marginalBytes: 0,
      versions: [{ version: '30.0.0', digest: null, state: 'keep', rule: 'implicit_install', marginalBytes: 0 }],
    },
  ],
  collected: [],
  totals: {
    retirable: 3, deprecate: 2, notice: 0, yank: 1, reverse: 1, refused: 0, deferred: 1,
    refusedPlugins: 0, marginalBytes: 3 * 1024 * 1024, awaitingCollection: 2, stuck: 0,
  },
  storage: MEASURED,
  ...over,
});

const ranReport = (): RetentionReport => {
  const r = report({ dryRun: false });
  const v = r.plugins[0].versions;
  v[2] = { ...v[2], action: 'deprecated' };
  v[3] = { ...v[3], action: 'deferred', error: 'later pass' };
  v[4] = { ...v[4], action: 'failed', error: 'registry timeout' };
  v[5] = { ...v[5], action: 'reversed' };
  r.collected = [
    { name: 'eslint', version: '8.6.0', digest: null, outcome: 'collected' },
    { name: 'eslint', version: '8.5.0', digest: null, outcome: 'held', rule: 'pipeline_reference' },
  ];
  return r;
};

const holdsAll = () => true;
const holdsNone = () => false;

beforeEach(() => {
  jest.clearAllMocks();
  fns.getRetentionPlan.mockImplementation(() => ok(report()));
  fns.runRetentionPass.mockImplementation(() => ok(ranReport()));
});

describe('retention helpers', () => {
  it('maps rule codes to words and keeps unknown codes readable', () => {
    expect(retentionRuleLabel('within_keep')).toBe('Within the newest versions kept per major');
    expect(retentionRuleLabel('pipeline_reference')).toBe('A pipeline references it');
    expect(retentionRuleLabel('superseded_in_major')).toBe('Superseded within its major');
    expect(retentionRuleLabel('some_new_rule')).toBe('some new rule');
    expect(retentionStateLabel('notice')).toBe('In notice');
    expect(retentionStateLabel('mystery')).toBe('mystery');
  });

  it('formats reclaimable bytes, or says not measured when null or incomplete', () => {
    expect(reclaimableText(2 * 1024 * 1024, MEASURED)).toMatch(/2(\.0)? MB/);
    expect(reclaimableText(null, MEASURED)).toBe('not measured');
    expect(reclaimableText(1024, { measured: true, incomplete: true })).toBe('not measured');
    expect(reclaimableText(1024, { measured: false, incomplete: false })).toBe('not measured');
  });

  it('labels deferred versions from the flag or the run action, and counts them', () => {
    expect(isDeferred({ deferred: true })).toBe(true);
    expect(isDeferred({ action: 'deferred' })).toBe(true);
    expect(isDeferred({ action: 'deprecated' })).toBe(false);
    expect(deferredCount(report())).toBe(1);
    // A run's batch cap also defers, without the plan's flag.
    expect(deferredCount(ranReport())).toBe(1);
    const capped = ranReport();
    capped.plugins[0].versions[2] = { ...capped.plugins[0].versions[2], action: 'deferred' };
    expect(deferredCount(capped)).toBe(2);
    expect(retentionTotalsLines(capped).find((l) => l.label === 'Deferred')!.value).toBe('2');
  });

  it('lists the totals, adding Refused only when something was refused', () => {
    const lines = retentionTotalsLines(report());
    expect(lines.map((l) => l.label)).toEqual(['Retirable', 'Deprecate', 'In notice', 'Yank', 'Reverse', 'Deferred', 'Awaiting collection', 'Stuck', 'Reclaimable']);
    expect(lines.find((l) => l.label === 'Reclaimable')!.value).toMatch(/3(\.0)? MB/);
    const refused = report();
    refused.totals.refused = 4;
    refused.totals.refusedPlugins = 1;
    expect(retentionTotalsLines(refused).find((l) => l.label === 'Refused')!.value).toBe('4 (1 plugin)');
    expect(retentionTotalsLines(report({ storage: { measured: true, incomplete: true } })).find((l) => l.label === 'Reclaimable')!.value).toBe('not measured');
  });

  it('states the configuration', () => {
    expect(fractionText(0.25)).toBe('25%');
    expect(retentionConfigText(report({ enabled: false }))).toContain('Scheduled pass disabled');
    expect(retentionConfigText(report())).toContain('keep 3 per major');
    expect(retentionConfigText(report())).toContain('30-day notice');
    expect(retentionConfigText(report())).toContain('50%');
  });

  it('allows a manual run whatever the scheduled switch says; only permission and session block it', () => {
    expect(runAvailability({ mayModerate: true, readOnly: false })).toEqual({ allowed: true, reason: null });
    expect(runAvailability({ mayModerate: false, readOnly: false }).reason).toBe('Requires plugins:moderate');
    expect(runAvailability({ mayModerate: true, readOnly: true }).reason).toBe('This session is read-only');
  });

  it('summarises a run: actions, errors and collections', () => {
    const out = runOutcome(ranReport());
    expect(out.actions).toEqual([
      { action: 'deprecated', count: 1 }, { action: 'reversed', count: 1 }, { action: 'deferred', count: 1 }, { action: 'failed', count: 1 },
    ]);
    expect(out.problems).toEqual([{ ref: 'eslint@8.8.0', action: 'failed', error: 'registry timeout' }]);
    expect(out.collected).toEqual([{ outcome: 'collected', count: 1 }, { outcome: 'held', count: 1 }]);
    expect(out.collectionProblems.map((c) => c.version)).toEqual(['8.5.0']);
  });
});

describe('RetentionPanel', () => {
  it('is locked, not hidden, without plugins:moderate, and fetches nothing', () => {
    render(<RetentionPanel holds={holdsNone} can={holdsNone} readOnly={false} />);
    expect(screen.getByTestId('retention-locked').textContent).toContain('plugins:moderate');
    expect(fns.getRetentionPlan).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run a pass now' })).toBeNull();
  });

  it('renders the dry run: config, totals, kept-and-why, retirements and deferred', async () => {
    render(<RetentionPanel holds={holdsAll} can={holdsAll} readOnly={false} />);
    await screen.findByTestId('retention-panel');
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.queryByTestId('retention-refused')).toBeNull();
    expect(screen.getByTestId('retention-config').textContent).toContain('keep 3 per major');
    const totals = screen.getByTestId('retention-totals');
    expect(within(totals).getByText('Reclaimable').nextSibling!.textContent).toMatch(/3(\.0)? MB/);

    const eslint = document.querySelector('[data-plugin="eslint"]') as HTMLElement;
    const row = (v: string) => eslint.querySelector(`[data-version="${v}"]`) as HTMLElement;
    expect(row('9.1.0').textContent).toContain('Kept');
    expect(row('9.1.0').textContent).toContain('A pipeline references it');
    expect(row('9.0.0').textContent).toContain('Deprecate');
    expect(row('8.9.0').textContent).toContain('Deferred');
    expect(row('9.0.0').textContent).not.toContain('Deferred');
    expect(row('8.8.0').textContent).toContain('Yank');
    expect(row('8.7.0').textContent).toContain('Reverse deprecation');
    expect(row('8.7.0').textContent).toContain('An install pins it');
    // A plugin with nothing to retire is hidden until asked for.
    expect(document.querySelector('[data-plugin="jest"]')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(document.querySelector('[data-plugin="jest"]')).not.toBeNull();
  });

  it('names why a refused plugin was refused', async () => {
    const r = report();
    r.plugins[0] = { ...r.plugins[0], refusedReason: 'resolution_refresh_incomplete', versions: r.plugins[0].versions.map((v) => (v.state === 'keep' ? v : { ...v, state: 'refused' as const, deferred: undefined })) };
    fns.getRetentionPlan.mockImplementation(() => ok(r));
    render(<RetentionPanel holds={holdsAll} can={holdsAll} readOnly={false} />);
    expect((await screen.findByTestId('retention-refused')).textContent).toContain('did not finish');
    expect((document.querySelector('[data-version="9.0.0"]') as HTMLElement).textContent).toContain('Refused');
  });

  it('says "not measured" when the registry measurement is incomplete', async () => {
    fns.getRetentionPlan.mockImplementation(() => ok(report({ storage: { measured: true, incomplete: true } })));
    render(<RetentionPanel holds={holdsAll} can={holdsAll} readOnly={false} />);
    const totals = await screen.findByTestId('retention-totals');
    expect(within(totals).getByText('Reclaimable').nextSibling!.textContent).toBe('not measured');
  });

  it('runs a pass behind the step-up and shows what it did, even when the schedule is disabled', async () => {
    fns.getRetentionPlan.mockImplementation(() => ok(report({ enabled: false })));
    render(<RetentionPanel holds={holdsAll} can={holdsAll} readOnly={false} />);
    await screen.findByTestId('retention-panel');
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByTestId('retention-disabled-note')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Run a pass now' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'step-up' });
    expect(within(dialog).getByTestId('retention-run-confirm').textContent).toContain('acts anyway');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm identity' }));
    await waitFor(() => expect(fns.runRetentionPass).toHaveBeenCalledWith('step-up-token'));
    const result = await screen.findByTestId('retention-run-result');
    expect(result.textContent).toContain('Deprecated: 1');
    expect(result.textContent).toContain('registry timeout');
    expect(result.textContent).toContain('Collected: 1');
    expect(result.textContent).toContain('A pipeline references it');
    expect(fns.getRetentionPlan).toHaveBeenCalledTimes(2);
  });

  it('disables the run with the reason on a read-only session, while still reading', async () => {
    render(<RetentionPanel holds={holdsAll} can={holdsNone} readOnly />);
    await screen.findByTestId('retention-panel');
    expect((screen.getByRole('button', { name: 'Run a pass now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('retention-run-blocked').textContent).toContain('Requires plugins:moderate');
  });

  it('shows a run refusal in the panel', async () => {
    fns.runRetentionPass.mockImplementation(() => Promise.reject(new Error('step-up expired')));
    render(<RetentionPanel holds={holdsAll} can={holdsAll} readOnly={false} />);
    await screen.findByTestId('retention-panel');
    fireEvent.click(screen.getByRole('button', { name: 'Run a pass now' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'step-up' })).getByRole('button', { name: 'Confirm identity' }));
    expect((await screen.findByTestId('retention-run-error')).textContent).toContain('step-up expired');
  });
});

describe('Retention nav entry', () => {
  it('is a system-org Platform → Catalog row gated on plugins:moderate', () => {
    const item = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.href === '/dashboard/admin/ecosystem?tab=storage&section=retention');
    expect(item).toMatchObject({ requiredPermission: 'plugins:moderate', systemOrgOnly: true, group: 'Catalog' });
    expect(item?.paletteOnly).toBeUndefined();
  });
});
