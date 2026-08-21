// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Render test for the org-admin Incident Reporting settings panel: asserts the
 * webhook endpoint URLs (generic + Alertmanager adapter), the loaded correlation
 * window, the provider-preset switch, and the recent-incidents list. The token
 * generate flow hands off to a (mocked) StepUpModal.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { IncidentReportingSettings } from '../src/components/settings/IncidentReportingSettings';

jest.mock('@/components/ui/Toast', () => ({
  __esModule: true,
  useToast: () => ({ success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() }),
}));

// StepUpModal → a simple marker so we can assert the token flow opened it.
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: () => <div data-testid="stepup-modal" />,
}));

const getIncidentSettings = jest.fn();
const listIncidents = jest.fn();
const createPat = jest.fn();
const sendTestIncident = jest.fn();
const putReportingSettings = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getIncidentSettings: (...a: unknown[]) => getIncidentSettings(...a),
    listIncidents: (...a: unknown[]) => listIncidents(...a),
    createPat: (...a: unknown[]) => createPat(...a),
    sendTestIncident: (...a: unknown[]) => sendTestIncident(...a),
    putReportingSettings: (...a: unknown[]) => putReportingSettings(...a),
  },
}));

describe('IncidentReportingSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getIncidentSettings.mockResolvedValue({
      incidentWindowHours: 6, defaultWindowHours: 24,
      eventRetentionDays: null, doraRetentionDays: null,
      defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
    });
    listIncidents.mockResolvedValue({
      success: true,
      data: {
        incidents: [
          { incidentId: 'pd-1', environment: 'production', severity: 'critical', openedAt: '2026-08-01T00:00:00Z', resolvedAt: '2026-08-01T01:00:00Z', createdAt: '2026-08-01T00:00:01Z', resolved: true, correlatedExecutionId: 'exec-A', deployCompletedAt: '2026-07-31T23:00:00Z' },
        ],
        pagination: { limit: 25, offset: 0, hasMore: false },
      },
    });
  });

  it('renders the generic + Alertmanager webhook endpoints', async () => {
    render(<IncidentReportingSettings />);
    // Generic appears once (Endpoints card); the Alertmanager adapter appears in
    // both the Endpoints card and the default (Alertmanager) provider preset.
    expect(await screen.findByText(/\/api\/reports\/incidents$/)).toBeInTheDocument();
    expect(screen.getAllByText(/\/api\/reports\/incidents\/alertmanager$/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows the loaded per-org correlation window (override)', async () => {
    render(<IncidentReportingSettings />);
    await waitFor(() => expect(getIncidentSettings).toHaveBeenCalled());
    expect(await screen.findByText(/override/)).toBeInTheDocument();
    expect(await screen.findByText(/6h/)).toBeInTheDocument();
  });

  it('opens the step-up modal when generating a webhook token', async () => {
    render(<IncidentReportingSettings />);
    fireEvent.click(screen.getByRole('button', { name: /generate webhook token/i }));
    expect(await screen.findByTestId('stepup-modal')).toBeInTheDocument();
  });

  it('runs a non-persisting test-incident correlation and shows the result', async () => {
    sendTestIncident.mockResolvedValue({ environment: 'production', openedAt: '2026-08-20T00:00:00Z', windowHours: 6, correlated: true, executionId: 'exec-A', deployCompletedAt: '2026-08-19T23:00:00Z' });
    render(<IncidentReportingSettings />);
    fireEvent.click(screen.getByRole('button', { name: /send test incident/i }));
    await waitFor(() => expect(sendTestIncident).toHaveBeenCalledWith('production'));
    expect(await screen.findByText(/Correlated to deploy/)).toBeInTheDocument();
  });

  it('lists recent incidents with their correlated deploy', async () => {
    render(<IncidentReportingSettings />);
    expect(await screen.findByText('pd-1')).toBeInTheDocument();
    expect(screen.getByText('exec-A')).toBeInTheDocument();
  });

  it('shows the default split retention windows (30 / 180 days)', async () => {
    render(<IncidentReportingSettings />);
    await waitFor(() => expect(getIncidentSettings).toHaveBeenCalled());
    expect(await screen.findByText(/30 days/)).toBeInTheDocument();
    expect((await screen.findAllByText(/180 days/)).length).toBeGreaterThanOrEqual(1);
  });

  it('renders retention READ-ONLY (no editable inputs, no save) with an extend CTA', async () => {
    render(<IncidentReportingSettings />);
    await waitFor(() => expect(getIncidentSettings).toHaveBeenCalled());
    // Retention is billing-owned now: no editable inputs, no save button.
    expect(screen.queryByRole('button', { name: /save retention/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('30')).not.toBeInTheDocument();
    // Deep-link CTA to buy a retention / DORA-History pack, highlighting the pack.
    const cta = screen.getByRole('link', { name: /extend retention/i });
    expect(cta).toHaveAttribute('href', expect.stringContaining('highlight=dora_history_pack'));
    // putReportingSettings is never called for retention.
    expect(putReportingSettings).not.toHaveBeenCalled();
  });

  it('shows "Unlimited" when the effective retention is -1', async () => {
    getIncidentSettings.mockResolvedValue({
      incidentWindowHours: null, defaultWindowHours: 24,
      eventRetentionDays: -1, doraRetentionDays: -1,
      defaultEventRetentionDays: 30, defaultDoraRetentionDays: 180,
    });
    render(<IncidentReportingSettings />);
    await waitFor(() => expect(getIncidentSettings).toHaveBeenCalled());
    expect(screen.getAllByText(/Unlimited/).length).toBeGreaterThanOrEqual(1);
  });
});
