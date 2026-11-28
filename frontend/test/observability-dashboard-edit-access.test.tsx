// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Who may edit a dashboard is decided per dashboard by ops-center
 * (`dashboardService.canWrite`): a system admin; otherwise never a public
 * dashboard, never another org's; its creator; or a `dashboards:write` holder
 * for an ORG-visible one. The PUT route itself names no permission.
 *
 * So the Edit page must let a creator without `dashboards:write` save, and
 * the dashboard page must not offer Edit / Delete on another member's PRIVATE
 * dashboard to a `dashboards:write` holder (the server refuses both).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DashboardEditPage from '../pages/dashboard/observability/[id]/edit';
import DashboardPage from '../pages/dashboard/observability/[id]';
import { canEditDashboard } from '@/components/observability/dashboard-access';
import { mockAuthGuard } from './helpers/pageMocks';
import type { Dashboard } from '@/types/observability';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());
jest.mock('@/hooks/useUnsavedChangesWarning', () => ({ __esModule: true, useUnsavedChangesWarning: () => () => {} }));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: { id: 'd1' }, pathname: '/dashboard/observability/[id]', replace: jest.fn<AnyFn>(), push: jest.fn<AnyFn>() })));
jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => function Grid() { return null; },
}));

let mockDashboard: unknown = {};
const updateDashboard = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  api: {
    getDashboard: () => Promise.resolve({ data: { dashboard: mockDashboard } }),
    observabilityCatalog: () => Promise.resolve({ data: { entries: [] } }),
    observabilityQueryBatch: () => Promise.resolve({ data: { results: {} } }),
    updateDashboard: (...a: unknown[]) => updateDashboard(...a),
  },
}));

const dash = (over: Partial<Dashboard> = {}): Dashboard & { panels: [] } => ({
  id: 'd1', orgId: 'org-1', createdBy: 'u-author', createdAt: '', updatedBy: '', updatedAt: '',
  name: 'Mine', description: null, layoutJson: {}, visibility: 'private', panels: [], ...over,
});

beforeEach(() => {
  updateDashboard.mockReset().mockResolvedValue({ success: true, data: {} });
  mockDashboard = dash();
});

describe('dashboard edit access', () => {
  it('the creator without dashboards:write can save their dashboard', async () => {
    mockAuthGuard({ user: { id: 'u-author', organizationId: 'org-1' }, can: () => false });
    render(<DashboardEditPage />);
    const save = await screen.findByRole('button', { name: /save/i });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(updateDashboard).toHaveBeenCalledWith('d1', expect.objectContaining({ name: 'Mine' })));
  });

  it('a dashboards:write holder is not offered Edit / Delete on another member\'s private dashboard', async () => {
    mockAuthGuard({ user: { id: 'u-other', organizationId: 'org-1' }, can: (p: string) => p === 'dashboards:write' });
    render(<DashboardPage />);
    await screen.findByRole('button', { name: /clone/i });
    expect(screen.queryByRole('link', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('mirrors the server rule', () => {
    const viewer = (id: string, can: (p: string) => boolean, extra: Record<string, unknown> = {}) => ({
      user: { id, organizationId: 'org-1', ...extra } as never, can, isReadOnly: false,
    });
    const writer = (p: string) => p === 'dashboards:write';
    const none = () => false;
    expect(canEditDashboard(dash(), viewer('u-author', none))).toBe(true);
    expect(canEditDashboard(dash({ visibility: 'org' }), viewer('u-other', writer))).toBe(true);
    expect(canEditDashboard(dash({ visibility: 'private' }), viewer('u-other', writer))).toBe(false);
    expect(canEditDashboard(dash({ orgId: 'org-2' }), viewer('u-author', writer))).toBe(false);
    expect(canEditDashboard(dash({ visibility: 'public', createdBy: 'u-author' }), viewer('u-author', writer))).toBe(false);
    expect(canEditDashboard(dash({ visibility: 'public', orgId: 'system' }), viewer('u-admin', none, { isSuperAdmin: true }))).toBe(true);
    expect(canEditDashboard(dash(), { ...viewer('u-author', none), isReadOnly: true })).toBe(false);
  });
});
