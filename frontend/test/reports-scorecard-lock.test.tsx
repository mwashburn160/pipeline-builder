// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Scorecard roll-up is served on `pipelines:read`, not the page's
 * `reports:read`. Without it the tab is LOCKED, not hidden — a bookmarked
 * `?tab=scorecard` used to render nothing under a refresh control that spun
 * for ever, because no tab mounted to report its status.
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
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ isReady: true, query: { tab: 'scorecard' }, pathname: '/dashboard/reports', replace: jest.fn<AnyFn>() })));
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/components/reports/tabs/ScorecardTab', () => ({ __esModule: true, ScorecardTab: () => <div>scorecard-body</div>, default: () => <div>scorecard-body</div> }));
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => () => Promise.resolve({ success: true, data: {} }) }),
}));

import ReportsPage from '../pages/dashboard/reports';

describe('Reports — Scorecard without pipelines:read', () => {
  it('a deep link lands on the reason, with the tab locked', async () => {
    mockAuthGuard({ can: (p: string) => p !== 'pipelines:read' });
    render(<ReportsPage />);
    expect(await screen.findByText('The Scorecard needs pipeline read access')).toBeInTheDocument();
    const tab = screen.getByRole('button', { name: /^scorecard$/i });
    expect(tab).toBeDisabled();
    expect(tab).toHaveAttribute('title', 'Requires the pipelines:read permission');
    expect(screen.queryByText('scorecard-body')).not.toBeInTheDocument();
  });
});
