// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The dashboard home (`pages/dashboard/index.tsx`), with the real create modal
 * mounted through next/dynamic and only `@/lib/api` mocked:
 *  - a member sees their recent runs, inbox count, the stats strip and the
 *    execution trend; switching the trend window re-reads the report;
 *  - both headline reads failing is a load error with Retry, not an empty org;
 *  - the hero's Git URL opens the modal on that URL (and starts generating);
 *  - "Upload config" → paste → Create sends `POST /pipelines` and refreshes;
 *  - a failed create shows on the modal; read-only blocks every entry point;
 *  - role homes: sysadmin and org admin (fresh account → onboarding).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import { apiFn, resetApiMock } from './helpers/apiMock';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());
jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useFeatureGate', () => ({
  __esModule: true,
  useFeatureGate: () => ({ entitled: true, isLoaded: true, label: 'AI', description: '', unlocks: '', upsellHref: '/', reason: '' }),
}));
// The role homes have their own suites; here only WHICH one renders matters.
jest.mock('@/components/dashboard/SysadminHome', () => ({ __esModule: true, SysadminHome: () => <div>sysadmin-home</div> }));
jest.mock('@/components/dashboard/OrgAdminHome', () => ({ __esModule: true, OrgAdminHome: () => <div>org-admin-home</div> }));
jest.mock('@/components/dashboard/NewOrgWelcome', () => ({
  __esModule: true,
  NewOrgWelcome: ({ onDismiss }: { onDismiss: () => void }) => <button type="button" onClick={onDismiss}>welcome-dismiss</button>,
}));
jest.mock('next/dynamic', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: (loader: () => Promise<{ default?: unknown }>) => {
      const Lazy = React.lazy(async () => {
        const m = await loader();
        return { default: (m.default ?? m) as React.ComponentType<Record<string, unknown>> };
      });
      return function Dynamic(props: Record<string, unknown>) {
        return React.createElement(React.Suspense, { fallback: null }, React.createElement(Lazy, props));
      };
    },
  };
});

import DashboardPage from '../pages/dashboard/index';

const today = new Date().toISOString().slice(0, 10);
const EXEC = [
  { id: 'pl-1', pipeline_name: 'web', project: 'web', total: 10, succeeded: 9, failed: 1, last_execution: '2026-11-16T10:00:00Z' },
  { id: 'pl-2', pipeline_name: '', project: 'api', total: 5, succeeded: 5, failed: 0, last_execution: '2026-11-17T10:00:00Z' },
];
const PROPS = { project: 'web', organization: 'acme', synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } } };

beforeEach(() => {
  resetApiMock();
  try { localStorage.clear(); } catch { /* none */ }
  mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', username: 'dana' }, can: () => true });
  apiFn('getExecutionCount').mockResolvedValue({ success: true, data: { pipelines: EXEC } });
  apiFn('listPipelines').mockResolvedValue({ success: true, data: { pipelines: [], pagination: { total: 7 } } });
  apiFn('getPluginSummary').mockResolvedValue({ success: true, data: { summary: { active: 4 } } });
  apiFn('getUnreadCount').mockResolvedValue({ success: true, data: { count: 3 } });
  apiFn('getSuccessRate').mockResolvedValue({ success: true, data: { timeline: [{ period: today, succeeded: 3, failed: 1, canceled: 0 }, { period: '2026-11-10', succeeded: 0, failed: 0, canceled: 0 }] } });
  apiFn('createPipeline').mockResolvedValue({ success: true, data: { pipeline: { id: 'new' } } });
});

describe('dashboard home — member', () => {
  it('shows recent runs, the inbox, stats and the trend; the window re-reads the report', async () => {
    render(<DashboardPage />);
    expect(await screen.findByText('7')).toBeInTheDocument(); // pipeline total, not the 2 in the exec report
    expect(screen.getByText('15')).toBeInTheDocument(); // total executions
    expect(screen.getByText('93%')).toBeInTheDocument(); // 14 of 15
    expect(await screen.findByText('4')).toBeInTheDocument(); // active plugins
    expect(await screen.findByText('unread messages')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.getByText('100% ok')).toBeInTheDocument();
    // Newest run first; a run with no name falls back to its project.
    const links = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/dashboard/pipelines/'));
    expect(links.map((a) => a.textContent)).toEqual(['api', 'web']);

    expect(await screen.findByText(/Execution Trend \(last 7 days\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '30d' }));
    expect(await screen.findByText(/Execution Trend \(last 30 days\)/)).toBeInTheDocument();
    await waitFor(() => expect(apiFn('getSuccessRate')).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('both headline reads failing is a load error with Retry, not a fresh org', async () => {
    apiFn('getExecutionCount').mockRejectedValue(new Error('exec down'));
    apiFn('listPipelines').mockRejectedValue(new Error('pipelines down'));
    render(<DashboardPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/exec down/);
    const before = apiFn('getExecutionCount').mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(apiFn('getExecutionCount').mock.calls.length).toBeGreaterThan(before));
  });

  it('the hero URL opens the create modal on that URL', async () => {
    apiFn('getAIProviders').mockResolvedValue({ success: true, data: { providers: [{ id: 'anthropic', name: 'A', models: [{ id: 'm', name: 'M' }] }] } });
    render(<DashboardPage />);
    const hero = await screen.findByPlaceholderText('https://github.com/owner/repo');
    expect(screen.getByRole('button', { name: /^Generate/ })).toBeDisabled();
    fireEvent.change(hero, { target: { value: ' https://github.com/acme/web ' } });
    fireEvent.keyDown(hero, { key: 'Enter' });
    expect(await screen.findByLabelText('Git repository URL')).toHaveValue('https://github.com/acme/web');
    await waitFor(() => expect(apiFn('streamPipelineFromUrl')).toHaveBeenCalled());
  });

  it('Upload config → Create sends the pipeline and refreshes the home', async () => {
    render(<DashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Upload config/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Pipeline Props (JSON)'), { target: { value: JSON.stringify(PROPS) } });
    const readsBefore = apiFn('getExecutionCount').mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(apiFn('createPipeline')).toHaveBeenCalledTimes(1));
    expect(apiFn('createPipeline').mock.calls[0][0]).toMatchObject({ project: 'web', organization: 'acme', props: PROPS, visibility: 'org' });
    await waitFor(() => expect(screen.queryByLabelText('Pipeline Props (JSON)')).not.toBeInTheDocument());
    await waitFor(() => expect(apiFn('getExecutionCount').mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('a failed create stays on the modal with the error', async () => {
    apiFn('createPipeline').mockRejectedValue(new Error('Quota exceeded'));
    render(<DashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Create manually/ }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Upload' }));
    fireEvent.change(screen.getByLabelText('Pipeline Props (JSON)'), { target: { value: JSON.stringify(PROPS) } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    expect(await screen.findByText(/Quota exceeded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('read-only blocks every create entry point', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', username: 'dana' }, can: () => false, isReadOnly: true });
    render(<DashboardPage />);
    expect(await screen.findByPlaceholderText('https://github.com/owner/repo')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Upload config/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Create manually/ })).toBeDisabled();
  });

  it('a brand-new org shows onboarding, which can be dismissed for good', async () => {
    apiFn('getExecutionCount').mockResolvedValue({ success: true, data: { pipelines: [] } });
    apiFn('listPipelines').mockResolvedValue({ success: true, data: { pipelines: [], pagination: { total: 0 } } });
    render(<DashboardPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'welcome-dismiss' }));
    expect(screen.queryByRole('button', { name: 'welcome-dismiss' })).not.toBeInTheDocument();
    expect(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('org-1')) ?? '')).toBe('1');
  });
});

describe('dashboard home — role homes', () => {
  it('a sysadmin gets the operations home and no trend', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'system', username: 'root' }, isSuperAdmin: true, isAdmin: true });
    render(<DashboardPage />);
    expect(await screen.findByText('sysadmin-home')).toBeInTheDocument();
    expect(screen.queryByText(/Execution Trend/)).not.toBeInTheDocument();
  });

  it('an org admin with activity gets the org-admin home', async () => {
    mockAuthGuard({ user: { id: 'u1', organizationId: 'org-1', username: 'owner' }, isAdmin: true, can: () => true });
    apiFn('getOrganizationMembers').mockResolvedValue({ success: true, data: { members: [{}, {}], pagination: { total: 2 } } });
    render(<DashboardPage />);
    expect(await screen.findByText('org-admin-home')).toBeInTheDocument();
  });

  it('renders the loading page until the guard is ready', () => {
    mockAuthGuard({ isReady: false });
    render(<DashboardPage />);
    expect(screen.queryByText('Generate a pipeline from Git')).not.toBeInTheDocument();
  });
});
