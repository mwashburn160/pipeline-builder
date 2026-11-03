// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "N AI calls left" BEFORE a generation, on every AI surface.
 *
 * Pins the rules the surfaces share (`lib/ai-quota`, `AIQuotaHint`,
 * `useAIQuota`): only a call on the PLATFORM's key spends `aiCalls`, so an own
 * key says so instead of counting down and never locks the button; a capped
 * quota with nothing left disables Generate with an upgrade link (prominent on
 * a trial tier); an unreadable quota shows and blocks nothing. Then two real
 * surfaces — the pipeline prompt tab and the Ask panel — wired end to end.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, renderHook, screen, waitFor, fireEvent } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import type { QuotaSummary } from '../src/types';
import { aiKeySource, aiQuotaBlocked, isAITrialTier } from '../src/lib/ai-quota';
import { AIQuotaHint } from '../src/components/ui/AIQuotaHint';
import { useAIQuota } from '../src/hooks/useAIQuota';
import { ApiError } from '../src/lib/api/errors';
import { formatAIError, isAIMemberShareError } from '../src/lib/ai-errors';
import PromptGenerateTab from '../src/components/pipeline/PromptGenerateTab';
import { AskPanel } from '../src/components/ask/AskPanel';
import { ReportReview } from '../src/components/reports/stakeholder/ReportReview';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());

const getOwnQuotas = jest.fn<AnyFn>();
const getAIProviders = jest.fn<AnyFn>();
const getAskProviders = jest.fn<AnyFn>();
const getOrgAIConfig = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getOwnQuotas: (...a: unknown[]) => getOwnQuotas(...a),
    getAIProviders: (...a: unknown[]) => getAIProviders(...a),
    getAskProviders: (...a: unknown[]) => getAskProviders(...a),
    getOrgAIConfig: (...a: unknown[]) => getOrgAIConfig(...a),
    getAskAvailability: async () => ({ success: true, data: { available: true } }),
  },
}));

const RESET = '2026-11-05T00:00:00.000Z';
const summary = (over: Partial<QuotaSummary> = {}): QuotaSummary => ({
  limit: 200, used: 13, remaining: 187, unlimited: false, resetAt: RESET, ...over,
});
const quotaResponse = (s: QuotaSummary, tier = 'pro') => ({
  success: true,
  data: { quota: { orgId: 'o1', name: 'Acme', slug: 'acme', tier, quotas: { aiCalls: s } } },
});

describe('lib/ai-quota', () => {
  it('derives the key source the call will use, with the backend precedence', () => {
    expect(aiKeySource({ customApiKey: '', currentSource: 'server' })).toBe('platform');
    expect(aiKeySource({ customApiKey: '', currentSource: 'org' })).toBe('org');
    expect(aiKeySource({ customApiKey: 'sk-1', currentSource: 'org' })).toBe('request');
    expect(aiKeySource({ customApiKey: '  ', currentSource: 'none' })).toBe('platform');
    // The Ask-agent entry takes no key override, so a leftover typed key is ignored.
    expect(aiKeySource({ customApiKey: 'sk-1', currentSource: 'agent' })).toBe('platform');
  });

  it('blocks only a platform-key call on a capped, exhausted quota', () => {
    const empty = summary({ used: 200, remaining: 0 });
    expect(aiQuotaBlocked(empty, 'platform')).toBe(true);
    expect(aiQuotaBlocked(empty, 'org')).toBe(false);
    expect(aiQuotaBlocked(empty, 'request')).toBe(false);
    expect(aiQuotaBlocked(summary({ remaining: 0, unlimited: true }), 'platform')).toBe(false);
    expect(aiQuotaBlocked(null, 'platform')).toBe(false);
    expect(aiQuotaBlocked(summary(), 'platform')).toBe(false);
  });

  it('treats the developer tier as the AI trial', () => {
    expect(isAITrialTier('developer')).toBe(true);
    expect(isAITrialTier('pro')).toBe(false);
    expect(isAITrialTier(undefined)).toBe(false);
  });
});

describe('AIQuotaHint', () => {
  it('says how many calls are left and when they reset', () => {
    render(<AIQuotaHint quota={{ summary: summary(), tier: 'pro' }} keySource="platform" />);
    expect(screen.getByTestId('ai-quota-hint')).toHaveTextContent(/^187 AI calls left · resets /);
  });

  it('labels a trial allowance as such', () => {
    render(<AIQuotaHint quota={{ summary: summary({ limit: 20, used: 3, remaining: 17 }), tier: 'developer' }} keySource="platform" />);
    expect(screen.getByTestId('ai-quota-hint')).toHaveTextContent(/^17 trial AI calls left/);
  });

  it('says an own key is not counted instead of counting down', () => {
    render(<AIQuotaHint quota={{ summary: summary({ remaining: 0 }), tier: 'pro' }} keySource="org" />);
    expect(screen.getByTestId('ai-quota-hint')).toHaveTextContent('Uses your own key — doesn\'t count toward AI calls');
  });

  it('shows a prominent upgrade CTA once a trial is used up', () => {
    render(<AIQuotaHint quota={{ summary: summary({ limit: 20, used: 20, remaining: 0 }), tier: 'developer' }} keySource="platform" />);
    expect(screen.getByTestId('ai-quota-hint')).toHaveTextContent(/Your 20 trial AI calls are used up/);
    expect(screen.getByRole('link', { name: /Upgrade your plan/ })).toHaveAttribute('href', '/dashboard/billing?tab=plans');
  });

  it('links a paid org at its limit to billing', () => {
    render(<AIQuotaHint quota={{ summary: summary({ used: 200, remaining: 0 }), tier: 'pro' }} keySource="platform" />);
    expect(screen.getByTestId('ai-quota-hint')).toHaveTextContent(/^No AI calls left/);
    expect(screen.getByRole('link', { name: 'Upgrade for more' })).toHaveAttribute('href', '/dashboard/billing');
  });

  it('renders nothing for an unlimited or unreadable quota', () => {
    const { container, rerender } = render(<AIQuotaHint quota={null} keySource="platform" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AIQuotaHint quota={{ summary: summary({ unlimited: true }) }} keySource="platform" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useAIQuota', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('reads once on open and again when a generation settles — no polling', async () => {
    getOwnQuotas.mockResolvedValue(quotaResponse(summary()));
    const { result, rerender } = renderHook(({ busy }) => useAIQuota(busy), { initialProps: { busy: false } });
    await waitFor(() => expect(result.current.quota?.summary.remaining).toBe(187));
    expect(getOwnQuotas).toHaveBeenCalledTimes(1);

    rerender({ busy: true });
    expect(getOwnQuotas).toHaveBeenCalledTimes(1);
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ used: 14, remaining: 186 })));
    rerender({ busy: false });
    await waitFor(() => expect(result.current.quota?.summary.remaining).toBe(186));
    expect(getOwnQuotas).toHaveBeenCalledTimes(2);
  });

  it('fails open to null when the quota read fails', async () => {
    getOwnQuotas.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useAIQuota());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.quota).toBeNull();
  });
});

describe('a used-up member share', () => {
  it('reads as its own refusal, not a busy provider or the org quota', () => {
    // The quota service's shape: `quota.limit` is the MEMBER's share.
    const err = new ApiError('share spent', 429, 'AI_MEMBER_SHARE_EXCEEDED', {
      quota: { type: 'aiCalls', limit: 40, used: 40, remaining: 0, resetAt: RESET }, quotaType: 'aiCalls', resetAt: RESET,
    });
    expect(isAIMemberShareError(err)).toBe(true);
    const msg = formatAIError(err, 'x');
    expect(msg).toMatch(/^You've used your share of your organization's AI calls for this period \(40 of 40\)\. It resets /);
    expect(msg).toMatch(/per-member share on the Quotas page/);
    expect(msg).not.toMatch(/Try again in a moment/);
  });

  it('a spent org token budget keeps the server sentence, without "try again"', () => {
    const err = new ApiError('Your organization\'s AI token budget for this period is spent.', 429, 'AI_TOKEN_BUDGET_EXCEEDED');
    expect(formatAIError(err, 'x')).toBe('Your organization\'s AI token budget for this period is spent.');
  });
});

describe('PromptGenerateTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAIProviders.mockResolvedValue({ data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'm', name: 'M' }] }] } });
    getAskProviders.mockResolvedValue({ data: { providers: [] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {}, aiEnabled: true } });
  });

  it('shows the calls left before generating', async () => {
    getOwnQuotas.mockResolvedValue(quotaResponse(summary()));
    render(<PromptGenerateTab />);
    expect(await screen.findByTestId('ai-quota-hint')).toHaveTextContent(/187 AI calls left/);
  });

  it('disables Generate with the upgrade link when the platform quota is used up', async () => {
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ limit: 20, used: 20, remaining: 0 }), 'developer'));
    render(<PromptGenerateTab />);
    fireEvent.change(await screen.findByLabelText('Describe your pipeline'), { target: { value: 'a node pipeline' } });
    await screen.findByText(/trial AI calls are used up/);
    expect(screen.getByRole('button', { name: /Generate from prompt/ })).toBeDisabled();
  });

  it('keeps Generate available on the org\'s own key even at the limit', async () => {
    getOrgAIConfig.mockResolvedValue({ data: { providers: { anthropic: { configured: true } }, aiEnabled: true } });
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ used: 200, remaining: 0 })));
    render(<PromptGenerateTab />);
    fireEvent.change(await screen.findByLabelText('Describe your pipeline'), { target: { value: 'a node pipeline' } });
    expect(await screen.findByText(/Uses your own key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate from prompt/ })).toBeEnabled();
  });
});

describe('AskPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
    mockAuthGuard({ can: () => true });
    getAskProviders.mockResolvedValue({ data: { providers: [{ id: 'anthropic', name: 'Anthropic', models: [{ id: 'c', name: 'C' }] }] } });
    getOrgAIConfig.mockResolvedValue({ data: { providers: {} } });
  });

  it('shows the calls left above the composer', async () => {
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ remaining: 1, used: 199 })));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    expect(await screen.findByTestId('ai-quota-hint')).toHaveTextContent(/^1 AI call left/);
  });

  it('will not send a question on the platform key once the quota is used up', async () => {
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ used: 200, remaining: 0 })));
    render(<AskPanel onClose={jest.fn<AnyFn>()} />);
    await screen.findByText(/No AI calls left/);
    fireEvent.change(screen.getByPlaceholderText(/Ask a question/i), { target: { value: 'hi' } });
    expect(screen.getByLabelText('Send')).toBeDisabled();
  });
});

describe('ReportReview "Draft with AI"', () => {
  const run = {
    id: 'run-1', status: 'review', version: 1, periodLabel: 'October 2026',
    periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-10-31T00:00:00.000Z',
    leadNotes: '', snapshot: { sections: [], notes: [] },
  } as never;
  const renderReview = () => render(
    <ReportReview run={run} canAuthor canShare={false} externalSharing={false} onChanged={jest.fn<AnyFn>()} />,
  );

  beforeEach(() => { jest.clearAllMocks(); });

  it('shows the calls left beside the button, and disables it at the limit on the platform key', async () => {
    getOrgAIConfig.mockResolvedValue({ data: { providers: {}, aiEnabled: true } });
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ used: 200, remaining: 0 })));
    renderReview();
    expect(await screen.findByText(/No AI calls left/)).toBeInTheDocument();
    expect(screen.getByTestId('draft-summary-ai')).toBeDisabled();
  });

  it('says an org key drafts it uncounted — the route uses the org\'s saved key first', async () => {
    getOrgAIConfig.mockResolvedValue({ data: { providers: { openai: { configured: true } }, aiEnabled: true } });
    getOwnQuotas.mockResolvedValue(quotaResponse(summary({ used: 200, remaining: 0 })));
    renderReview();
    expect(await screen.findByText(/Uses your own key/)).toBeInTheDocument();
    expect(screen.getByTestId('draft-summary-ai')).toBeEnabled();
  });

  it('a keyless provider (Bedrock) is not an org key', async () => {
    getOrgAIConfig.mockResolvedValue({ data: { providers: { 'amazon-bedrock': { configured: true } }, aiEnabled: true } });
    getOwnQuotas.mockResolvedValue(quotaResponse(summary()));
    renderReview();
    expect(await screen.findByText(/187 AI calls left/)).toBeInTheDocument();
  });
});
