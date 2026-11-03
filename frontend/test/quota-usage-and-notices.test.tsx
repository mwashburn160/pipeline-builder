// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The quota surfaces added with the usage ledger and the structured 429:
 *
 *  - a 429 QUOTA_EXCEEDED becomes a QuotaExceededError carrying the body's
 *    fields, and the global notice renders which quota / when it resets / the
 *    upgrade link on ANY page;
 *  - the "What used this" breakdown reads the ledger and exports CSV;
 *  - the forecast and banner use the server's period, never "monthly".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuotaExceededError } from '@/lib/api/errors';
import { QuotaExceededNotice } from '@/components/ui/QuotaBanner';
import { UsageForecast, periodLabel } from '@/components/quotas/QuotaCard';
import { QuotaUsageBreakdown } from '@/components/quotas/QuotaUsageBreakdown';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getQuotaUsage = jest.fn<AnyFn>();
const downloadQuotaUsageCsv = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => {
  const api = {
    getQuotaUsage: (...a: unknown[]) => getQuotaUsage(...a),
    downloadQuotaUsageCsv: (...a: unknown[]) => downloadQuotaUsageCsv(...a),
  };
  return { __esModule: true, default: api, api };
});
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('QuotaExceededError', () => {
  it('lifts the structured 429 fields off `details`', () => {
    const err = new QuotaExceededError('API call quota reached (5/5); resets 2026-11-05. Upgrade at /dashboard/billing.', {
      quotaType: 'apiCalls', limit: 5, used: 5, resetAt: '2026-11-05T00:00:00.000Z', upgradeUrl: '/dashboard/billing',
    });
    expect(err).toMatchObject({ statusCode: 429, code: 'QUOTA_EXCEEDED', quotaType: 'apiCalls', limit: 5, used: 5, upgradeUrl: '/dashboard/billing' });
    expect(new QuotaExceededError('x').quotaType).toBeUndefined();
  });
});

describe('QuotaExceededNotice', () => {
  it('renders nothing until a refusal is dispatched, then names the quota, reset and upgrade link', () => {
    const { container } = render(<QuotaExceededNotice />);
    expect(container).toBeEmptyDOMElement();

    act(() => {
      window.dispatchEvent(new CustomEvent('quota-exceeded', {
        detail: { message: 'm', quotaType: 'automationCalls', limit: 10, used: 10, resetAt: '2026-11-05T00:00:00.000Z', upgradeUrl: '/dashboard/billing' },
      }));
    });
    expect(screen.getByText(/Automation calls quota reached/)).toBeInTheDocument();
    expect(screen.getByText(/Resets/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upgrade tier/i })).toHaveAttribute('href', '/dashboard/billing');
    expect(screen.getByRole('link', { name: /what used it/i })).toHaveAttribute('href', '/dashboard/quotas');

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(container).toBeEmptyDOMElement();
  });

  it('never links off-site, and falls back to the message without a reset time', () => {
    render(<QuotaExceededNotice />);
    act(() => {
      window.dispatchEvent(new CustomEvent('quota-exceeded', { detail: { message: 'Quota reached.', upgradeUrl: '//evil.example.com' } }));
    });
    expect(screen.getByText('Quota reached.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upgrade tier/i })).toHaveAttribute('href', '/dashboard/billing');
  });
});

describe('UsageForecast', () => {
  it('projects over the server\'s period, not 30 days', () => {
    // A 3-day period, 1.5 days in, 60 used of 100 → pace 120 by reset.
    const resetAt = new Date(Date.now() + 1.5 * 86_400_000).toISOString();
    render(<UsageForecast used={60} limit={100} resetAt={resetAt} periodDays={3} />);
    expect(screen.getByText(/will breach/)).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(periodLabel(3)).toBe('3-day period');
  });

  it('stays quiet with no signal', () => {
    const { container } = render(<UsageForecast used={0} limit={100} resetAt={new Date().toISOString()} periodDays={3} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('QuotaUsageBreakdown', () => {
  const breakdown = {
    orgId: 'root', type: 'apiCalls', groupBy: 'principal', from: '', to: '', retentionDays: 90,
    groups: [
      { key: 'sa-1', principalType: 'service_account', keyCount: 2, counted: 30, denied: 4, overshoot: 0, refunded: 0, net: 30 },
      { key: null, counted: 10, denied: 0, overshoot: 0, refunded: 0, net: 10 },
    ],
  };

  it('shows who used the quota, with refusals and share, scoped to the whole account for a root', async () => {
    getQuotaUsage.mockResolvedValue({ success: true, data: breakdown });
    render(<QuotaUsageBreakdown orgId="root" isTeam={false} periodDays={3} />);

    expect(await screen.findByText('sa-1')).toBeInTheDocument();
    expect(screen.getByText(/Service account · 2 keys/)).toBeInTheDocument();
    expect(screen.getByText('Unattributed')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText(/whole organization/)).toBeInTheDocument();
    expect(screen.getByText(/kept for 90 days/)).toBeInTheDocument();
    expect(getQuotaUsage).toHaveBeenCalledWith('root', { type: 'apiCalls', groupBy: 'principal', from: undefined }, expect.anything());
  });

  it('re-queries on a new grouping / type / range, and exports the same view as CSV', async () => {
    getQuotaUsage.mockResolvedValue({ success: true, data: { ...breakdown, groups: [] } });
    const blob = new Blob(['x']);
    downloadQuotaUsageCsv.mockResolvedValue({ blob, filename: 'quota-usage.csv' });
    render(<QuotaUsageBreakdown orgId="team-a" isTeam periodDays={3} />);
    expect(await screen.findByText(/Nothing used this quota/)).toBeInTheDocument();
    expect(screen.getByText(/This team’s own usage/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'pipeline' } });
    fireEvent.change(screen.getByLabelText('Quota'), { target: { value: 'automationCalls' } });
    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '30' } });
    await waitFor(() => expect(getQuotaUsage).toHaveBeenLastCalledWith(
      'team-a', expect.objectContaining({ type: 'automationCalls', groupBy: 'pipeline', from: expect.any(String) }), expect.anything(),
    ));

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(blob, 'quota-usage.csv'));
  });

  it('a failed read shows an error rather than an empty table', async () => {
    getQuotaUsage.mockRejectedValue(new Error('nope'));
    render(<QuotaUsageBreakdown orgId="root" isTeam={false} />);
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});
