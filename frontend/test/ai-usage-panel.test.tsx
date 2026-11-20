// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The AI assistant usage report:
 *
 *  - `AiUsagePanel` (beside "What used this" on the quotas page) reads the
 *    report in the org's reporting timezone, offers the team rollup only to a
 *    `reports:rollup` holder at a root, shows the acceptance empty state, and
 *    exports CSV;
 *  - `useAiDraftOutcome` reports what became of each AI draft — accepted,
 *    edited then accepted, or discarded — exactly once, carrying only the
 *    feature and the outcome.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { AiUsagePanel } from '@/components/quotas/AiUsagePanel';
import { useAiDraftOutcome } from '@/hooks/useAiDraftOutcome';
import type { AiUsageReport } from '@/types/ai-usage';
import { createRef } from 'react';
import PromptGenerateTab, { type PromptGenerateTabRef } from '@/components/pipeline/PromptGenerateTab';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const getAiUsageReport = jest.fn<AnyFn>();
const downloadAiUsageCsv = jest.fn<AnyFn>();
const getReportPolicy = jest.fn<AnyFn>();
const recordAiDraftOutcome = jest.fn<AnyFn>();
const streamPipelineFromPrompt = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = {
    getAiUsageReport: (...a: unknown[]) => getAiUsageReport(...a),
    downloadAiUsageCsv: (...a: unknown[]) => downloadAiUsageCsv(...a),
    getReportPolicy: (...a: unknown[]) => getReportPolicy(...a),
    recordAiDraftOutcome: (...a: unknown[]) => recordAiDraftOutcome(...a),
    // PromptGenerateTab's own reads.
    getOwnQuotas: async () => ({ success: true, data: { quota: { quotas: {} } } }),
    getAIProviders: async () => ({ data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'm', name: 'M' }] }] } }),
    getAskProviders: async () => ({ data: { providers: [] } }),
    getOrgAIConfig: async () => ({ data: { providers: {}, aiEnabled: true } }),
    getAskAvailability: async () => ({ success: true, data: { available: true } }),
    streamPipelineFromPrompt: (...a: unknown[]) => streamPipelineFromPrompt(...a),
  };
  return { __esModule: true, default: api, api };
});
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

const zero = { calls: 0, units: 0, tokensIn: 0, tokensOut: 0, accepted: 0, editedAccepted: 0, discarded: 0, outcomes: 0, acceptanceRate: null };

function report(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    orgId: 'root', scope: 'org', from: '2026-10-21T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z',
    interval: 'day', tz: 'America/Chicago', weekStart: 'sunday', retentionDays: 90, acceptanceSince: null,
    totals: { ...zero, calls: 12, units: 10, tokensIn: 3000, tokensOut: 900 },
    buckets: [{ bucket: '2026-11-19', ...zero, calls: 12, units: 10 }],
    byCallerType: [{ callerType: 'user', calls: 10, units: 9, tokensIn: 0, tokensOut: 800 }, { callerType: 'system', calls: 2, units: 1, tokensIn: 0, tokensOut: 100 }],
    byTeam: null,
    byFeature: [{ feature: 'agent-tool', ...zero, calls: 7, units: 6 }, { feature: 'pipeline-generate', ...zero, calls: 5, units: 4 }],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard({ can: () => false });
  getReportPolicy.mockResolvedValue({ success: true, data: { policy: { defaultTimezone: 'America/Chicago', defaultWeekStart: 'sunday' } } });
  recordAiDraftOutcome.mockResolvedValue({ success: true });
});

describe('AiUsagePanel', () => {
  it('reads the report in the org\'s reporting tz/weekStart, own org only without reports:rollup, and shows the acceptance empty state', async () => {
    getAiUsageReport.mockResolvedValue({ success: true, data: { report: report() } });
    render(<AiUsagePanel orgId="root" isTeam={false} />);

    expect(await screen.findByText('Ask agent tools')).toBeInTheDocument();
    expect(screen.getByText('Pipeline generation')).toBeInTheDocument();
    expect(screen.getByText('User sessions')).toBeInTheDocument();
    expect(screen.getByText(/Draft acceptance starts with this release/)).toBeInTheDocument();
    expect(screen.getByText(/never per person/)).toBeInTheDocument();
    expect(screen.queryByLabelText('AI usage scope')).not.toBeInTheDocument();
    const [orgId, params] = getAiUsageReport.mock.calls[0] as [string, Record<string, unknown>];
    expect(orgId).toBe('root');
    expect(params).toMatchObject({ interval: 'day', tz: 'America/Chicago', weekStart: 'sunday' });
    expect(params.includeDescendants).toBeUndefined();
  });

  it('a reports:rollup holder at a root gets the team rollup, by team name', async () => {
    mockAuthGuard({ can: (p: string) => p === 'reports:rollup' });
    getAiUsageReport.mockResolvedValue({
      success: true,
      data: { report: report({ scope: 'rollup', byTeam: [{ orgId: 'team-a', name: 'Payments', calls: 8, units: 7, tokensIn: 0, tokensOut: 0 }] }) },
    });
    render(<AiUsagePanel orgId="root" isTeam={false} />);
    expect(await screen.findByText('Payments')).toBeInTheDocument();
    expect(getAiUsageReport.mock.calls[0]![1]).toMatchObject({ includeDescendants: true });

    fireEvent.change(screen.getByLabelText('AI usage scope'), { target: { value: 'org' } });
    await waitFor(() => expect(getAiUsageReport).toHaveBeenCalledTimes(2));
    expect((getAiUsageReport.mock.calls[1]![1] as Record<string, unknown>).includeDescendants).toBeUndefined();
  });

  it('a team never offers the rollup, even to a reports:rollup holder', async () => {
    mockAuthGuard({ can: () => true });
    getAiUsageReport.mockResolvedValue({ success: true, data: { report: report() } });
    render(<AiUsagePanel orgId="team-a" isTeam />);
    await screen.findByText('Ask agent tools');
    expect(screen.queryByLabelText('AI usage scope')).not.toBeInTheDocument();
  });

  it('shows acceptance per feature once recorded, and says when tracking began inside the range', async () => {
    getAiUsageReport.mockResolvedValue({
      success: true,
      data: {
        report: report({
          acceptanceSince: '2026-11-10T00:00:00.000Z',
          totals: { ...zero, calls: 12, units: 10, accepted: 2, editedAccepted: 1, discarded: 1, outcomes: 4, acceptanceRate: 0.75 },
          byFeature: [{ feature: 'pipeline-generate', ...zero, calls: 5, units: 4, accepted: 2, editedAccepted: 1, discarded: 1, outcomes: 4, acceptanceRate: 0.75 }],
        }),
      },
    });
    render(<AiUsagePanel orgId="root" isTeam={false} />);
    expect(await screen.findByText(/Draft acceptance has been recorded since/)).toBeInTheDocument();
    expect(screen.getAllByText('75%').length).toBeGreaterThanOrEqual(2);
  });

  it('empty range: says so, still explains acceptance; weekly re-query; exports CSV', async () => {
    getAiUsageReport.mockResolvedValue({ success: true, data: { report: report({ totals: zero, buckets: [], byCallerType: [], byFeature: [] }) } });
    downloadAiUsageCsv.mockResolvedValue({ blob: new Blob(['x']), filename: 'ai-usage.csv' });
    render(<AiUsagePanel orgId="root" isTeam={false} />);
    expect(await screen.findByText('No AI calls in the selected range.')).toBeInTheDocument();
    expect(screen.getByText(/Draft acceptance starts with this release/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('AI usage interval'), { target: { value: 'week' } });
    await waitFor(() => expect(getAiUsageReport).toHaveBeenCalledTimes(2));
    expect(getAiUsageReport.mock.calls[1]![1]).toMatchObject({ interval: 'week' });

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalled());
    expect(downloadAiUsageCsv.mock.calls[0]![1]).toMatchObject({ interval: 'week', tz: 'America/Chicago' });
  });

  it('a failed read shows an error, not a blank card', async () => {
    getAiUsageReport.mockRejectedValue(new Error('boom'));
    render(<AiUsagePanel orgId="root" isTeam={false} />);
    expect(await screen.findByText(/boom|Could not load AI usage/)).toBeInTheDocument();
  });
});

describe('useAiDraftOutcome', () => {
  it('reports an untouched draft as accepted, once', () => {
    const { result } = renderHook(() => useAiDraftOutcome());
    act(() => { result.current.offered('pipeline-generate', { b: 1, a: { y: 2, x: 1 } }); });
    // Same draft, different key order: not an edit.
    act(() => { result.current.accepted({ a: { x: 1, y: 2 }, b: 1 }); });
    act(() => { result.current.accepted({ a: 1 }); });
    expect(recordAiDraftOutcome.mock.calls).toEqual([['pipeline-generate', 'accepted']]);
  });

  it('reports a changed draft as edited_accepted — and never sends the draft itself', () => {
    const { result } = renderHook(() => useAiDraftOutcome());
    act(() => { result.current.offered('agent', { project: 'secret-project' }); });
    act(() => { result.current.accepted({ project: 'renamed' }); });
    expect(recordAiDraftOutcome.mock.calls).toEqual([['agent', 'edited_accepted']]);
    expect(JSON.stringify(recordAiDraftOutcome.mock.calls)).not.toContain('secret-project');
  });

  it('a draft replaced by a new one, or left pending at unmount, is discarded', () => {
    const { result, unmount } = renderHook(() => useAiDraftOutcome());
    act(() => { result.current.offered('plugin-generate', { v: 1 }); });
    act(() => { result.current.offered('plugin-generate', { v: 2 }); });
    unmount();
    expect(recordAiDraftOutcome.mock.calls).toEqual([['plugin-generate', 'discarded'], ['plugin-generate', 'discarded']]);
  });

  it('nothing pending ⇒ nothing sent, and a failing send never throws', async () => {
    recordAiDraftOutcome.mockRejectedValue(new Error('offline'));
    const { result, unmount } = renderHook(() => useAiDraftOutcome());
    act(() => { result.current.accepted({}); });
    expect(recordAiDraftOutcome).not.toHaveBeenCalled();
    act(() => { result.current.offered('agent', {}); });
    unmount();
    await Promise.resolve();
    expect(recordAiDraftOutcome).toHaveBeenCalledWith('agent', 'discarded');
  });
});

describe('PromptGenerateTab reports what became of its draft', () => {
  const props = { project: 'demo', organization: 'acme', synth: { source: { type: 'github', options: { repo: 'acme/demo' } } }, stages: [] };

  async function generate() {
    streamPipelineFromPrompt.mockImplementation(async function* () { yield { type: 'done', data: { props } }; });
    const ref = createRef<PromptGenerateTabRef>();
    const view = render(<PromptGenerateTab ref={ref} />);
    fireEvent.change(await screen.findByLabelText('Describe your pipeline'), { target: { value: 'a node pipeline' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Generate from prompt/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Generate from prompt/ }));
    await waitFor(() => expect(streamPipelineFromPrompt).toHaveBeenCalled());
    await waitFor(() => expect(ref.current?.getDescription()).toBe(''));
    await act(async () => { await Promise.resolve(); });
    return { ref, view };
  }

  it('a pipeline created from the untouched draft is accepted (pipeline-generate)', async () => {
    const { ref } = await generate();
    await waitFor(async () => expect(await ref.current!.getProps()).not.toBeNull());
    act(() => { ref.current!.markAccepted(); });
    expect(recordAiDraftOutcome.mock.calls).toEqual([['pipeline-generate', 'accepted']]);
  });

  it('a draft left behind when the dialog closes is discarded', async () => {
    const { ref, view } = await generate();
    await waitFor(async () => expect(await ref.current!.getProps()).not.toBeNull());
    view.unmount();
    expect(recordAiDraftOutcome.mock.calls).toEqual([['pipeline-generate', 'discarded']]);
  });
});

