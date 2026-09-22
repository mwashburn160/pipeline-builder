// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Executions page: first-run vs filtered-empty states, and stat cards that
 * each state a distinct fact (and each select one value of the status filter).
 */

import { it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { mockAuthGuard } from './helpers/pageMocks';
import type { ExecutionCountRow } from '@/types';

jest.mock('@/hooks/useAuthGuard', () => require('./helpers/pageMocks').authGuardModule());
jest.mock('@/components/ui/DashboardLayout', () => require('./helpers/pageMocks').dashboardLayoutModule());
jest.mock('@/hooks/useOrgHierarchy', () => require('./helpers/pageMocks').orgHierarchyModule());
jest.mock('@/components/reports/IngestFreshness', () => ({ IngestFreshness: () => null }));
jest.mock('@/components/reports/useReportData', () => ({ useIngestHealth: () => ({ data: null, loading: false, error: null }) }));
jest.mock('@/hooks/useExecutionStatusStream', () => ({ useExecutionStatusStream: () => ({ connected: false }) }));
jest.mock('@/components/reports/ReportHelpers', () => ({ DateRangePicker: () => null }));

const push = jest.fn<AnyFn>();
jest.mock('next/router', () => require('./helpers/pageMocks').routerModule(() => ({ push, query: {}, pathname: '/dashboard/executions' })));

let rows: ExecutionCountRow[] = [];
jest.mock('@/hooks/useQuery', () => ({
  useQuery: () => ({ data: { success: true, data: { pipelines: rows } }, loading: false, error: null, refetch: jest.fn<AnyFn>() }),
}));

import ExecutionsPage from '../pages/dashboard/executions';

const row = (id: string, total: number, failed: number): ExecutionCountRow => ({
  id, pipeline_name: `pipe-${id}`, project: `proj-${id}`, organization: 'org-1',
  total, succeeded: total - failed, failed, canceled: 0, last_execution: '2026-09-18T00:00:00Z',
} as ExecutionCountRow);

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthGuard();
});

it('first run: says so, with a CTA to pipelines', () => {
  rows = [];
  render(<ExecutionsPage />);
  expect(screen.getByText('No executions yet')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Go to Pipelines' }));
  expect(push).toHaveBeenCalledWith('/dashboard/pipelines');
});

it('filtered to nothing: a distinct state with a Clear filters button that restores the list', () => {
  rows = [row('a', 5, 0), row('b', 3, 1)];
  render(<ExecutionsPage />);
  fireEvent.change(screen.getByPlaceholderText(/search pipelines/i), { target: { value: 'zzz' } });
  expect(screen.getByText('No executions match these filters')).toBeInTheDocument();
  expect(screen.queryByText('No executions yet')).not.toBeInTheDocument();

  const clearButtons = screen.getAllByRole('button', { name: 'Clear filters' });
  fireEvent.click(clearButtons[clearButtons.length - 1]);
  expect(screen.getByText('pipe-a')).toBeInTheDocument();
  expect(screen.getByText('pipe-b')).toBeInTheDocument();
});

it('stat cards show distinct facts and each selects its own filter', () => {
  rows = [row('a', 5, 0), row('b', 3, 1), row('c', 2, 2)];
  render(<ExecutionsPage />);

  const failing = screen.getByRole('button', { name: /pipelines with failures/i });
  const clean = screen.getByRole('button', { name: /all-clean pipelines/i });
  expect(within(failing).getByText('2')).toBeInTheDocument();
  expect(within(clean).getByText('1')).toBeInTheDocument();
  expect(screen.queryByText('Failed runs')).not.toBeInTheDocument();

  fireEvent.click(clean);
  expect(clean).toHaveAttribute('aria-pressed', 'true');
  expect(failing).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByText('pipe-a')).toBeInTheDocument();
  expect(screen.queryByText('pipe-b')).not.toBeInTheDocument();
  // Counting over the searched rows, not the status-filtered ones.
  expect(within(failing).getByText('2')).toBeInTheDocument();

  fireEvent.click(failing);
  expect(failing).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('pipe-a')).not.toBeInTheDocument();
  expect(screen.getByText('pipe-c')).toBeInTheDocument();
});
