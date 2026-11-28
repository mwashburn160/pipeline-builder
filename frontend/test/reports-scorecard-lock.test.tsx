// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org Scorecard roll-up is served on `reports:read` (the page's own read
 * gate), so a custom role with `reports:read` but no pipeline read opens it.
 */

import { describe, it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/hooks/useFeatures', () => ({
  __esModule: true,
  useFeatures: () => ({ isEnabled: () => true, features: [], isLoaded: true, supportAlias: 'support@pipeline-builder' }),
}));
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: { tab: 'quality', section: 'scorecard' }, pathname: '/dashboard/reports', replace: jest.fn<AnyFn>() })));
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/components/reports/tabs/ScorecardTab', () => ({ __esModule: true, ScorecardTab: () => <div>scorecard-body</div>, default: () => <div>scorecard-body</div> }));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => () => Promise.resolve({ success: true, data: {} }) }),
}));

import ReportsPage from '../pages/dashboard/reports';

describe('Reports — Scorecard gate', () => {
  it('opens for a reports:read holder without pipelines:read (the roll-up is served on reports:read)', async () => {
    mockAuthGuard({ can: (p: string) => p !== 'pipelines:read' });
    render(<ReportsPage />);
    expect(await screen.findByText('scorecard-body')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^quality$/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^scorecard$/i })).toBeEnabled();
  });

});
