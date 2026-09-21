// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor } from '@testing-library/react';
import { BillingDashboard } from '../src/components/billing/BillingDashboard';
import { mockOrgHierarchy } from './helpers/pageMocks';

jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());

const getBillingSummary = jest.fn<AnyFn>();
const listBillingInvoices = jest.fn<AnyFn>();
const getBillingAllocation = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getBillingSummary: (...a: unknown[]) => getBillingSummary(...a),
    listBillingInvoices: (...a: unknown[]) => listBillingInvoices(...a),
    getBillingAllocation: (...a: unknown[]) => getBillingAllocation(...a),
  },
}));

const allocation = (rows: any[]) => ({ data: { driver: 'seats', totals: {}, rows, unallocated: {} } });

const summary = (invoiceCount: number) => ({
  data: {
    scope: 'account',
    totals: { grossBilledCents: 9800, discountsCents: 0, creditsCents: 3000, taxCents: 0, netBilledCents: 6800, amountPaidCents: 6800 },
    timeline: [{ periodStart: '2026-06-01T00:00:00.000Z', grossCents: 4900, discountCents: 0, creditCents: 2000, netCents: 2900 }],
    invoiceCount,
  },
});
const invoices = {
  data: {
    invoices: [{ periodStart: '2026-06-01T00:00:00.000Z', periodEnd: '2026-07-01T00:00:00.000Z', grossCents: 4900, discountCents: 0, creditCents: 2000, taxCents: 0, netCents: 2900, amountPaidCents: 2900, status: 'paid' }],
    pagination: { total: 1, limit: 24, offset: 0 },
  },
};

beforeEach(() => {
  getBillingSummary.mockReset();
  listBillingInvoices.mockReset().mockResolvedValue(invoices);
  getBillingAllocation.mockReset().mockResolvedValue(allocation([])); // no subtree by default
  mockOrgHierarchy(); // flat org by default
});

describe('BillingDashboard', () => {
  it('renders the stat cards, timeline, and invoice table with billing history', async () => {
    getBillingSummary.mockResolvedValue(summary(1));
    render(<BillingDashboard />);
    expect(await screen.findByText('Amounts billed')).toBeInTheDocument();
    expect(screen.getByText('Total billed')).toBeInTheDocument();
    expect(screen.getByText('Net billed')).toBeInTheDocument();
    // Net total $68.00 surfaces on a stat card.
    expect(screen.getAllByText('$68.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
  });

  it('renders nothing for an account with no billing history', async () => {
    getBillingSummary.mockResolvedValue(summary(0));
    const { container } = render(<BillingDashboard />);
    await waitFor(() => expect(getBillingSummary).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Amounts billed')).not.toBeInTheDocument();
  });

  it('renders the cost-by-team table when the org parents teams', async () => {
    mockOrgHierarchy({ childOrgCount: 1, childOrgs: [{ id: 'team-a', name: 'Payments' }] });
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([
      { orgId: 'root', driverUnits: 6, sharePct: 75, grossCents: 3675, discountCents: 0, creditCents: 1500, taxCents: 0, netCents: 2175 },
      { orgId: 'team-a', driverUnits: 2, sharePct: 25, grossCents: 1225, discountCents: 0, creditCents: 500, taxCents: 0, netCents: 725 },
    ]));
    render(<BillingDashboard />);
    expect(await screen.findByText('Cost by team')).toBeInTheDocument();
    // Named from the session's org list, not left as a raw org id.
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.queryByText('team-a')).not.toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('falls back to the org id for a row the session cannot name', async () => {
    mockOrgHierarchy({ childOrgCount: 1 });
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([
      { orgId: 'team-z', driverUnits: 2, sharePct: 100, grossCents: 1225, discountCents: 0, creditCents: 0, taxCents: 0, netCents: 1225 },
    ]));
    render(<BillingDashboard />);
    expect(await screen.findByText('Cost by team')).toBeInTheDocument();
    expect(screen.getByText('team-z')).toBeInTheDocument();
  });

  it('skips the allocation request and hides cost-by-team for an org with no teams', async () => {
    getBillingSummary.mockResolvedValue(summary(1));
    render(<BillingDashboard />);
    await screen.findByText('Amounts billed');
    expect(getBillingAllocation).not.toHaveBeenCalled();
    expect(screen.queryByText('Cost by team')).not.toBeInTheDocument();
  });

  it('still shows cost-by-team when a parent org\'s allocation holds a single row', async () => {
    // Gating is the hierarchy signal, not the row count: "the parent carries
    // all of it this period" is an answer, and hiding it looked like the
    // breakdown didn't exist.
    mockOrgHierarchy({ childOrgCount: 1 });
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([{ orgId: 'root', driverUnits: 6, sharePct: 100, grossCents: 4900, discountCents: 0, creditCents: 2000, taxCents: 0, netCents: 2900 }]));
    render(<BillingDashboard />);
    expect(await screen.findByText('Cost by team')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('hides cost-by-team when the allocation read yields no rows at all', async () => {
    mockOrgHierarchy({ childOrgCount: 1 });
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([]));
    render(<BillingDashboard />);
    await screen.findByText('Amounts billed');
    expect(screen.queryByText('Cost by team')).not.toBeInTheDocument();
  });
});

describe('BillingDashboard — invoice paging', () => {
  it('pages the invoice table through the server', async () => {
    const { fireEvent } = await import('@testing-library/react');
    getBillingSummary.mockResolvedValue(summary(30));
    listBillingInvoices.mockResolvedValue({ data: { invoices: invoices.data.invoices, pagination: { total: 30, limit: 24, offset: 0 } } });
    render(<BillingDashboard />);
    await screen.findByText('Invoices');
    expect(listBillingInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, limit: 24 }), expect.anything());
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(listBillingInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 24, limit: 24 }), expect.anything()));
  });
});
