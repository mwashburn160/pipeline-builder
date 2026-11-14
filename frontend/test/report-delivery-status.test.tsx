// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A published stakeholder report's delivery line ("Delivered to N · M failed ·
 * K skipped" + the plain-sentence notes) and Redeliver, offered on exactly the
 * runs the redeliver route would accept (202) rather than refuse (409).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const redeliverReportRun = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { redeliverReportRun: (...a: unknown[]) => redeliverReportRun(...a) },
}));

import {
  DeliveryStatus, DELIVERY_STALE_MS, canRedeliver, deliveryIncomplete, deliverySummary,
} from '@/components/reports/stakeholder/DeliveryStatus';
import type { DeliveryOutcome, ReportRun } from '@/lib/api/domains/stakeholder-reports';

const NOW = Date.parse('2026-11-13T12:00:00Z');

const outcome = (over: Partial<DeliveryOutcome> = {}): DeliveryOutcome => ({
  state: 'delivered', attempts: 1, attemptedAt: '2026-11-13T11:00:00Z', inApp: 1,
  email: { sent: 4, failed: 0, skipped: 0 }, destinations: { delivered: 1, failed: 0 },
  emailAvailable: true, relayFailed: false, delivered: { recipientIds: [], destinationIds: [] }, notes: [],
  ...over,
});
const run = (over: Partial<ReportRun> = {}): ReportRun => ({
  id: 'run-1', definitionId: 'd1', periodStart: '2026-11-03', periodEnd: '2026-11-10', periodLabel: '2026-W45',
  version: 1, status: 'published', leadNotes: null, aiDraft: null, failureReason: null,
  publishedAt: '2026-11-13T11:00:00Z', publishedBy: 'u1', supersededBy: null, createdAt: '2026-11-13T10:00:00Z',
  delivery: outcome(), ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  redeliverReportRun.mockResolvedValue({ success: true, data: { run: run() } });
});

describe('delivery helpers (mirror api/reporting)', () => {
  it('summarises reached / failed / skipped', () => {
    expect(deliverySummary(outcome())).toBe('Delivered to 5');
    expect(deliverySummary(outcome({ email: { sent: 2, failed: 1, skipped: 3 }, destinations: { delivered: 0, failed: 2 } })))
      .toBe('Delivered to 2 · 3 failed · 3 skipped');
  });

  it('incomplete on a failed state, no in-app notice, a relay failure, or any failed address/destination', () => {
    expect(deliveryIncomplete(outcome())).toBe(false);
    expect(deliveryIncomplete(outcome({ state: 'failed' }))).toBe(true);
    expect(deliveryIncomplete(outcome({ inApp: 0 }))).toBe(true);
    expect(deliveryIncomplete(outcome({ relayFailed: true }))).toBe(true);
    expect(deliveryIncomplete(outcome({ email: { sent: 1, failed: 1, skipped: 0 } }))).toBe(true);
    expect(deliveryIncomplete(outcome({ destinations: { delivered: 0, failed: 1 } }))).toBe(true);
  });

  it('redeliverable exactly when the route would answer 202', () => {
    expect(canRedeliver(run(), NOW)).toBe(false); // fully delivered → 409
    expect(canRedeliver(run({ delivery: outcome({ state: 'failed' }) }), NOW)).toBe(true);
    expect(canRedeliver(run({ delivery: null }), NOW)).toBe(true); // published, nothing recorded
    expect(canRedeliver(run({ status: 'ready_for_review', delivery: null }), NOW)).toBe(false);
    expect(canRedeliver(run({ supersededBy: 'run-2', delivery: outcome({ state: 'failed' }) }), NOW)).toBe(false);
    const fresh = new Date(NOW - DELIVERY_STALE_MS + 60_000).toISOString();
    const stale = new Date(NOW - DELIVERY_STALE_MS).toISOString();
    expect(canRedeliver(run({ delivery: outcome({ state: 'delivering', attemptedAt: fresh }) }), NOW)).toBe(false);
    expect(canRedeliver(run({ delivery: outcome({ state: 'delivering', attemptedAt: stale }) }), NOW)).toBe(true);
  });
});

describe('<DeliveryStatus>', () => {
  it('renders nothing before publish', () => {
    const { container } = render(<DeliveryStatus run={run({ status: 'ready_for_review', delivery: null })} canShare onChanged={jest.fn<AnyFn>()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a complete delivery: the line, no Redeliver', () => {
    render(<DeliveryStatus run={run()} canShare onChanged={jest.fn<AnyFn>()} />);
    expect(screen.getByTestId('delivery-line')).toHaveTextContent('Delivered to 5');
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redeliver' })).not.toBeInTheDocument();
  });

  it('a failed delivery: notes, attempt count, the in-app-only remark, and Redeliver that re-reads the run', async () => {
    const onChanged = jest.fn<AnyFn>();
    render(<DeliveryStatus
      run={run({ delivery: outcome({
        state: 'failed', attempts: 2, emailAvailable: false, email: { sent: 0, failed: 0, skipped: 2 },
        notes: ['The email relay could not be reached.'],
      }) })}
      canShare
      onChanged={onChanged}
    />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByTestId('delivery-line')).toHaveTextContent('attempt 2');
    expect(screen.getByText('The email relay could not be reached.')).toBeInTheDocument();
    expect(screen.getByText(/went in-app only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redeliver' }));
    await waitFor(() => expect(redeliverReportRun).toHaveBeenCalledWith('run-1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText(/Redelivery started/)).toBeInTheDocument();
  });

  it('shows a 409 refusal in the server\'s words', async () => {
    redeliverReportRun.mockRejectedValue(new Error('This report is still being delivered — check back in a few minutes'));
    render(<DeliveryStatus run={run({ delivery: outcome({ state: 'failed' }) })} canShare onChanged={jest.fn<AnyFn>()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redeliver' }));
    expect(await screen.findByText(/still being delivered/)).toBeInTheDocument();
  });

  it('an in-flight delivery shows Delivering; a partial one is flagged; no record says so', () => {
    const { unmount } = render(<DeliveryStatus run={run({ delivery: outcome({ state: 'delivering', attemptedAt: new Date().toISOString() }) })} canShare onChanged={jest.fn<AnyFn>()} />);
    expect(screen.getByText('Delivering')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Redeliver' })).not.toBeInTheDocument();
    unmount();
    const partial = render(<DeliveryStatus run={run({ delivery: outcome({ email: { sent: 3, failed: 1, skipped: 0 } }) })} canShare onChanged={jest.fn<AnyFn>()} />);
    expect(screen.getByTestId('delivery-line')).toHaveTextContent('Delivered to 4 · 1 failed');
    expect(screen.getByRole('button', { name: 'Redeliver' })).toBeInTheDocument();
    partial.unmount();
    render(<DeliveryStatus run={run({ delivery: null })} canShare onChanged={jest.fn<AnyFn>()} />);
    expect(screen.getByTestId('delivery-line')).toHaveTextContent('No delivery has been recorded');
    expect(screen.getByRole('button', { name: 'Redeliver' })).toBeInTheDocument();
  });

  it('no Redeliver without reports:publish', () => {
    render(<DeliveryStatus run={run({ delivery: outcome({ state: 'failed' }) })} canShare={false} onChanged={jest.fn<AnyFn>()} />);
    expect(screen.queryByRole('button', { name: 'Redeliver' })).not.toBeInTheDocument();
  });
});
