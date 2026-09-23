// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `useComplianceAudit` holds the check-log state the Overview reads. What it
 * guarantees:
 *   - changing a filter refetches from page 1 EXPLICITLY (offset 0), not from
 *     the offset the previous page left behind
 *   - a slow response for a superseded filter never overwrites the current rows
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useComplianceAudit } from '../src/components/compliance/useComplianceAudit';

const getComplianceAuditLog = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getComplianceAuditLog: (...a: unknown[]) => getComplianceAuditLog(...a) },
}));

const page = (entries: { id: string }[], offset = 0, total = 100) => ({
  success: true,
  data: { entries, pagination: { limit: 25, offset, total } },
});

beforeEach(() => {
  getComplianceAuditLog.mockReset().mockResolvedValue(page([{ id: 'e1' }]));
});

describe('useComplianceAudit', () => {
  it('loads the first page on mount', async () => {
    const { result } = renderHook(() => useComplianceAudit());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(getComplianceAuditLog).toHaveBeenCalledWith({ limit: 25, offset: 0 });
  });

  it('sends each filter and returns to page 1 explicitly', async () => {
    const { result } = renderHook(() => useComplianceAudit());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    // Move off page 1 first, so a refetch at the stale offset would be visible.
    getComplianceAuditLog.mockResolvedValue(page([{ id: 'e2' }], 25));
    act(() => result.current.handlePageChange(25));
    await waitFor(() => expect(result.current.pagination.offset).toBe(25));

    getComplianceAuditLog.mockResolvedValue(page([{ id: 'e3' }]));
    act(() => result.current.setResult('block'));
    await waitFor(() => expect(getComplianceAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'block', offset: 0 }),
    ));
    expect(result.current.filtersActive).toBe(true);
  });

  it('reports filtersActive only while a filter narrows the log', async () => {
    const { result } = renderHook(() => useComplianceAudit());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.filtersActive).toBe(false);
    act(() => result.current.setTarget('plugin'));
    await waitFor(() => expect(result.current.filtersActive).toBe(true));
    act(() => result.current.setTarget(''));
    await waitFor(() => expect(result.current.filtersActive).toBe(false));
  });

  it('drops a superseded response instead of clobbering the current rows', async () => {
    const { result } = renderHook(() => useComplianceAudit());
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    // The first filter's answer is held open; the second resolves immediately.
    let releaseStale: (v: unknown) => void = () => {};
    getComplianceAuditLog.mockImplementationOnce(() => new Promise((res) => { releaseStale = res; }));
    act(() => result.current.setTarget('plugin'));

    getComplianceAuditLog.mockResolvedValue(page([{ id: 'fresh' }]));
    act(() => result.current.setTarget('pipeline'));
    await waitFor(() => expect(result.current.entries[0].id).toBe('fresh'));

    await act(async () => { releaseStale(page([{ id: 'stale' }])); });
    expect(result.current.entries[0].id).toBe('fresh');
  });

  it('surfaces a failed fetch as an error the caller can retry', async () => {
    getComplianceAuditLog.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useComplianceAudit());
    await waitFor(() => expect(result.current.error).toMatch(/failed to load audit log/i));

    getComplianceAuditLog.mockResolvedValue(page([{ id: 'ok' }]));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
