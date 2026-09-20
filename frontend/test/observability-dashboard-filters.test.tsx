// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard page audit filters: a `?requestId=` deep link (as preserved by the
 * /observability/audit-activity redirect) reaches the audit-trail query, and the
 * filter form writes event / actor / requestId into the URL.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DashboardPage from '../pages/dashboard/observability/[id]';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const replace = jest.fn();
let mockQuery: Record<string, string> = {};
jest.mock('next/router', () => ({
  __esModule: true,
  useRouter: () => ({ isReady: true, query: mockQuery, pathname: '/dashboard/observability/[id]', replace, push: jest.fn() }),
}));

// The grid driver is lazy + layout-heavy; render panels in order instead.
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => function Grid({ panels, renderPanel }: { panels: unknown[]; renderPanel: (p: unknown, i: number) => React.ReactNode }) {
    return <div>{panels.map((p, i) => <div key={i}>{renderPanel(p, i)}</div>)}</div>;
  },
}));

const observabilityAuditQuery = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: {
    getDashboard: jest.fn().mockResolvedValue({
      data: {
        dashboard: {
          id: 'd1', orgId: 'system', createdBy: 'system', createdAt: '', updatedBy: '', updatedAt: '',
          name: 'Audit activity', description: null, layoutJson: {}, visibility: 'public',
          panels: [{
            id: 'p1', dashboardId: 'd1', queryKey: 'audit_recent_events', vizKind: 'table',
            title: 'Recent events', span: 12, groupBy: null, format: null, position: 0,
          }],
        },
      },
    }),
    observabilityAuditQuery: (...a: unknown[]) => observabilityAuditQuery(...a),
  },
}));

beforeEach(() => {
  replace.mockReset();
  observabilityAuditQuery.mockReset().mockResolvedValue({ data: { entries: [], range: '1h' } });
  mockQuery = { id: 'd1' };
});

describe('Dashboard page — audit filters', () => {
  it('forwards a requestId deep link to the recent-events query and shows it in the banner', async () => {
    mockQuery = { id: 'd1', requestId: 'req-42' };
    render(<DashboardPage />);
    await waitFor(() => expect(observabilityAuditQuery).toHaveBeenCalled());
    expect(observabilityAuditQuery).toHaveBeenCalledWith(
      'audit_recent_events', '1h', expect.objectContaining({ requestId: 'req-42' }), expect.anything(),
    );
    expect(screen.getByText('requestId=req-42')).toBeInTheDocument();
  });

  it('writes the filter form into the URL (shallow), dropping blanks', async () => {
    render(<DashboardPage />);
    fireEvent.change(await screen.findByLabelText('Request ID'), { target: { value: ' req-7 ' } });
    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'pipeline.delete' } });
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(replace).toHaveBeenCalledWith(
      { pathname: '/dashboard/observability/[id]', query: { id: 'd1', range: '1h', event: 'pipeline.delete', requestId: 'req-7' } },
      undefined,
      { shallow: true },
    );
  });
});
