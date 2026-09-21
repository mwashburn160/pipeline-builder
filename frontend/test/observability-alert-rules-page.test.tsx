// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Alert-rules page: the list pages server-side (offset/limit), and system
 * admins get a read-only preview of the materialized Prometheus rule_files YAML.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertRulesPage from '../pages/dashboard/observability/alert-rules';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/components/RecentlyDeletedPanel', () => ({ __esModule: true, RecentlyDeletedPanel: () => null }));

const listAlertRules = jest.fn<AnyFn>();
const getMaterializedAlertRules = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: {
    listAlertRules: (...a: unknown[]) => listAlertRules(...a),
    getMaterializedAlertRules: (...a: unknown[]) => getMaterializedAlertRules(...a),
  },
}));

const rule = (i: number) => ({
  id: `r${i}`, orgId: 'org-1', name: `Rule ${i}`, expr: 'up == 0', forDuration: '5m',
  severity: 'warning', summary: 's', description: '', enabled: true,
});

beforeEach(() => {
  listAlertRules.mockReset().mockImplementation(({ offset, limit }: { offset: number; limit: number }) =>
    Promise.resolve({
      success: true,
      data: {
        rules: Array.from({ length: Math.min(limit, 30 - offset) }, (_, i) => rule(offset + i)),
        pagination: { total: 30, offset, limit, hasMore: offset + limit < 30 },
      },
    }));
  getMaterializedAlertRules.mockReset().mockResolvedValue('groups:\n  - name: org-1\n');
  mockAuthGuard();
});

describe('AlertRulesPage', () => {
  it('reads the first page, then the next one from the pager', async () => {
    render(<AlertRulesPage />);
    expect(await screen.findByText('Rule 0')).toBeInTheDocument();
    expect(listAlertRules).toHaveBeenCalledWith({ offset: 0, limit: 25 }, expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Rule 29')).toBeInTheDocument();
    expect(listAlertRules).toHaveBeenLastCalledWith({ offset: 25, limit: 25 }, expect.anything());
  });

  it('hides the rendered-rules preview from non-sysadmins', async () => {
    render(<AlertRulesPage />);
    await screen.findByText('Rule 0');
    expect(screen.queryByRole('button', { name: /preview rendered rules/i })).not.toBeInTheDocument();
    expect(getMaterializedAlertRules).not.toHaveBeenCalled();
  });

  it('shows sysadmins the materialized YAML read-only', async () => {
    mockAuthGuard({ isSuperAdmin: true });
    render(<AlertRulesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /preview rendered rules/i }));
    await waitFor(() => expect(getMaterializedAlertRules).toHaveBeenCalled());
    expect(await screen.findByText(/name: org-1/)).toBeInTheDocument();
  });
});
