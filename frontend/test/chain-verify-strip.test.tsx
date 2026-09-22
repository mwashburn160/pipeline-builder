// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A verification started for one org must never paint its verdict next to
 * another. The strip reset its result when the org in scope changed, but a
 * request still in flight landed afterwards and showed org A's "Chain intact"
 * beside org B.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, act } from '@testing-library/react';

const verifyAuditChain = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({ __esModule: true, default: { verifyAuditChain: (...a: unknown[]) => verifyAuditChain(...a) } }));

import { ChainVerifyStrip } from '../src/components/audit/ChainVerifyStrip';

it('drops a result that arrives after the org in scope changed', async () => {
  let resolveA: (v: unknown) => void = () => undefined;
  verifyAuditChain.mockReturnValueOnce(new Promise((r) => { resolveA = r; }));
  const { rerender } = render(<ChainVerifyStrip orgId="org-a" renderOrgRef={(id) => id} />);
  fireEvent.click(screen.getByRole('button', { name: /verify integrity/i }));
  const signal = (verifyAuditChain.mock.calls[0][1] as { signal: AbortSignal }).signal;

  rerender(<ChainVerifyStrip orgId="org-b" renderOrgRef={(id) => id} />);
  expect(signal.aborted).toBe(true);
  await act(async () => { resolveA({ success: true, data: { ok: true, count: 3 } }); });

  expect(screen.queryByText(/chain intact/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /verify integrity/i })).not.toBeDisabled();
});

it('names a truncated tail (no surviving row to point at) instead of "broken at unknown"', async () => {
  verifyAuditChain.mockResolvedValueOnce({ success: true, data: { ok: false, reason: 'tail-truncated', count: 2, lastSeq: 2 } });
  render(<ChainVerifyStrip orgId="org-a" renderOrgRef={(id) => id} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify integrity/i })); });

  expect(screen.getByText(/TAMPER DETECTED — the newest events were deleted/)).toBeInTheDocument();
  expect(screen.queryByText(/unknown/)).not.toBeInTheDocument();
});

it('names the offending event for a row-level break', async () => {
  verifyAuditChain.mockResolvedValueOnce({ success: true, data: { ok: false, reason: 'hash-mismatch', brokenAt: 'evt-9', count: 4 } });
  render(<ChainVerifyStrip orgId="org-a" renderOrgRef={(id) => id} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /verify integrity/i })); });

  expect(screen.getByText(/an event was altered \(at evt-9\)/)).toBeInTheDocument();
});
