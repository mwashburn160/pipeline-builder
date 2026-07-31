// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { render, screen, waitFor } from '@testing-library/react';
import { BillingDashboard } from '../src/components/billing/BillingDashboard';

const getBillingSummary = jest.fn();
const listBillingInvoices = jest.fn();
const getBillingAllocation = jest.fn();
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
});

describe('BillingDashboard', () => {
  it('renders the stat cards, timeline, and invoice table with billing history', async () => {
    getBillingSummary.mockResolvedValue(summary(1));
    render(<BillingDashboard />);
    expect(await screen.findByText('Amounts billed')).toBeInTheDocument();
    expect(screen.getByText('Total Billed')).toBeInTheDocument();
    expect(screen.getByText('Net Billed')).toBeInTheDocument();
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

  it('renders the cost-by-team table when the subtree has >1 org', async () => {
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([
      { orgId: 'root', driverUnits: 6, sharePct: 75, grossCents: 3675, discountCents: 0, creditCents: 1500, taxCents: 0, netCents: 2175 },
      { orgId: 'team-a', driverUnits: 2, sharePct: 25, grossCents: 1225, discountCents: 0, creditCents: 500, taxCents: 0, netCents: 725 },
    ]));
    render(<BillingDashboard />);
    expect(await screen.findByText('Cost by team')).toBeInTheDocument();
    expect(screen.getByText('team-a')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('hides the cost-by-team table for a single-org account', async () => {
    getBillingSummary.mockResolvedValue(summary(1));
    getBillingAllocation.mockResolvedValue(allocation([{ orgId: 'root', driverUnits: 6, sharePct: 100, grossCents: 4900, discountCents: 0, creditCents: 2000, taxCents: 0, netCents: 2900 }]));
    render(<BillingDashboard />);
    await screen.findByText('Amounts billed');
    expect(screen.queryByText('Cost by team')).not.toBeInTheDocument();
  });
});
