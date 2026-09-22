// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * "Recently deleted" for the observability resources.
 *
 * Dashboards, alert rules and alert destinations already had restore endpoints,
 * but no UI could list what was deleted — so a delete was effectively permanent.
 * They now ride the same shared panel as every other soft-delete domain, which
 * means the same contract: list the tombstones, and re-verify the password
 * (step-up) before either restore or the irreversible purge.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecentlyDeletedPanel } from '../src/components/RecentlyDeletedPanel';

const listDeletedDashboards = jest.fn<AnyFn>();
const restoreDashboard = jest.fn<AnyFn>();
const purgeDashboard = jest.fn<AnyFn>();
const listDeletedAlertRules = jest.fn<AnyFn>();
const restoreAlertRule = jest.fn<AnyFn>();
const purgeAlertRule = jest.fn<AnyFn>();
const listDeletedAlertDestinations = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    listDeletedDashboards: (...a: unknown[]) => listDeletedDashboards(...a),
    restoreDashboard: (...a: unknown[]) => restoreDashboard(...a),
    purgeDashboard: (...a: unknown[]) => purgeDashboard(...a),
    listDeletedAlertRules: (...a: unknown[]) => listDeletedAlertRules(...a),
    restoreAlertRule: (...a: unknown[]) => restoreAlertRule(...a),
    purgeAlertRule: (...a: unknown[]) => purgeAlertRule(...a),
    listDeletedAlertDestinations: (...a: unknown[]) => listDeletedAlertDestinations(...a),
    restoreAlertDestination: jest.fn<AnyFn>(),
    purgeAlertDestination: jest.fn<AnyFn>(),
  },
}));

// Step-up is a password re-verify dialog; stand in a button that hands back a
// token so the test can assert the token actually reaches the API call.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ onConfirmed }: { onConfirmed: (t: string) => void }) => (
    <button onClick={() => onConfirmed('stepup-token')}>confirm-step-up</button>
  ),
}));

// One toast spy object, shared by every render (the real `useToast` memoizes).
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

beforeEach(() => {
  jest.clearAllMocks();
  listDeletedDashboards.mockResolvedValue({ success: true, data: { dashboards: [
    { id: 'd1', name: 'Deploy overview', visibility: 'org', createdBy: 'u1', deletedAt: '2026-09-18T10:00:00Z', deletedBy: 'u1' },
  ] } });
  listDeletedAlertRules.mockResolvedValue({ success: true, data: { rules: [
    { id: 'r1', name: 'High failure rate', deletedAt: '2026-09-18T10:00:00Z', deletedBy: 'u1' },
  ] } });
  listDeletedAlertDestinations.mockResolvedValue({ success: true, data: { destinations: [
    { id: 'dst1', label: 'Ops Slack', channel: 'slack', target: '••••XXXXXXXX', hasTarget: true, deletedAt: '2026-09-18T10:00:00Z', deletedBy: 'u1' },
  ] } });
});

describe('RecentlyDeletedPanel — observability resources', () => {
  it('lists deleted dashboards', async () => {
    render(<RecentlyDeletedPanel resource="dashboard" />);
    expect(await screen.findByText('Deploy overview')).toBeInTheDocument();
    expect(listDeletedDashboards).toHaveBeenCalled();
  });

  it('restores a dashboard only after step-up, forwarding the token', async () => {
    const onRestored = jest.fn<AnyFn>();
    restoreDashboard.mockResolvedValue({ success: true });
    render(<RecentlyDeletedPanel resource="dashboard" onRestored={onRestored} />);
    await screen.findByText('Deploy overview');

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    // Nothing is called until the password is re-verified.
    expect(restoreDashboard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('confirm-step-up'));
    await waitFor(() => expect(restoreDashboard).toHaveBeenCalledWith('d1', 'stepup-token'));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it('purges a dashboard behind the same step-up gate', async () => {
    purgeDashboard.mockResolvedValue({ success: true });
    render(<RecentlyDeletedPanel resource="dashboard" />);
    await screen.findByText('Deploy overview');

    fireEvent.click(screen.getByRole('button', { name: /purge/i }));
    fireEvent.click(screen.getByText('confirm-step-up'));

    await waitFor(() => expect(purgeDashboard).toHaveBeenCalledWith('d1', 'stepup-token'));
  });

  it('lists + restores a deleted alert rule', async () => {
    restoreAlertRule.mockResolvedValue({ success: true });
    render(<RecentlyDeletedPanel resource="alert-rule" />);
    expect(await screen.findByText('High failure rate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    fireEvent.click(screen.getByText('confirm-step-up'));

    await waitFor(() => expect(restoreAlertRule).toHaveBeenCalledWith('r1', 'stepup-token'));
  });

  it('labels a deleted destination without exposing its target', async () => {
    render(<RecentlyDeletedPanel resource="alert-destination" />);
    // Label + channel identify the row; the (masked) target is never rendered.
    expect(await screen.findByText('Ops Slack (slack)')).toBeInTheDocument();
    expect(screen.queryByText(/••••/)).toBeNull();
  });

  it('surfaces a load failure instead of pretending nothing was deleted', async () => {
    listDeletedAlertRules.mockResolvedValue({ success: false });
    render(<RecentlyDeletedPanel resource="alert-rule" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/failed to load deleted alert rules/i);
  });
});
