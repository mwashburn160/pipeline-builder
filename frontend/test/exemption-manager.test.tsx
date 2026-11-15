// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ExemptionManager — the compliance security-exception workflow: request,
 * approve / reject (with reason), delete (confirmed), CSV bulk import (validated,
 * never coerced), and read failures shown as failures rather than "no
 * exemptions" (which reads as "nothing is exempted").
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { pageToast } from './helpers/pageMocks';
import { ApiError } from '@/lib/api/errors';
import { localDayEndIso } from '@/lib/local-day';

jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule());

const getExemptions = jest.fn<AnyFn>();
const createExemption = jest.fn<AnyFn>();
const reviewExemption = jest.fn<AnyFn>();
const deleteExemption = jest.fn<AnyFn>();
const bulkCreateExemptions = jest.fn<AnyFn>();
const extendExemptionExpiry = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    getExemptions: (...a: unknown[]) => getExemptions(...a),
    createExemption: (...a: unknown[]) => createExemption(...a),
    reviewExemption: (...a: unknown[]) => reviewExemption(...a),
    deleteExemption: (...a: unknown[]) => deleteExemption(...a),
    bulkCreateExemptions: (...a: unknown[]) => bulkCreateExemptions(...a),
    extendExemptionExpiry: (...a: unknown[]) => extendExemptionExpiry(...a),
  },
}));

import ExemptionManager from '@/components/compliance/ExemptionManager';

const exemption = (over: Record<string, unknown> = {}) => ({
  id: 'ex1', orgId: 'o', ruleId: 'r1', entityType: 'plugin', entityId: 'plug-1', entityName: 'trivy-scan',
  reason: 'Vendor fix pending', status: 'pending', createdAt: '2026-11-01T00:00:00Z', ...over,
});
const page = (rows: unknown[]) => ({ success: true, data: { exemptions: rows, pagination: { offset: 0, limit: 25, total: rows.length, hasMore: false } } });

beforeEach(() => {
  jest.clearAllMocks();
  getExemptions.mockResolvedValue(page([exemption()]));
  createExemption.mockResolvedValue({ success: true, data: { exemption: exemption() } });
  reviewExemption.mockResolvedValue({ success: true });
  deleteExemption.mockResolvedValue({ success: true });
  bulkCreateExemptions.mockResolvedValue({ success: true, data: { created: 2, skipped: 0, ids: [] } });
});

function csvFile(text: string) {
  const f = new File([text], 'ex.csv', { type: 'text/csv' });
  // jsdom's File lacks .text() in some versions.
  Object.defineProperty(f, 'text', { value: () => Promise.resolve(text) });
  return f;
}
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;

describe('ExemptionManager', () => {
  it('lists exemptions and filters by status on the server', async () => {
    render(<ExemptionManager />);
    expect(await screen.findByText('trivy-scan')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter exemptions by status'), { target: { value: 'approved' } });
    await waitFor(() => expect(getExemptions).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'approved', offset: 0 })));
  });

  it('an exemption the daily sweep expired shows Expired (not Approved) with no review actions', async () => {
    getExemptions.mockResolvedValue(page([exemption({ status: 'expired', expiresAt: '2026-10-01T00:00:00Z' })]));
    render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    expect(screen.getByText('Expired', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByText('Approved', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Filter exemptions by status'), { target: { value: 'expired' } });
    await waitFor(() => expect(getExemptions).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'expired' })));
  });

  it('a refused read shows an error with Retry, not "No exemptions found"', async () => {
    getExemptions.mockResolvedValueOnce({ success: false, message: 'compliance down' }).mockResolvedValue(page([exemption()]));
    render(<ExemptionManager />);
    expect(await screen.findByText(/compliance down/)).toBeInTheDocument();
    expect(screen.queryByText('No exemptions found.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('trivy-scan')).toBeInTheDocument();
  });

  it('requests an exemption with the form values', async () => {
    render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.click(screen.getByRole('button', { name: /Request/ }));
    const submit = screen.getByRole('button', { name: 'Submit Request' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rule ID'), { target: { value: 'r9' } });
    fireEvent.change(screen.getByLabelText('Entity ID'), { target: { value: 'pipe-7' } });
    fireEvent.change(screen.getByLabelText('Reason for exemption'), { target: { value: 'Legacy build' } });
    fireEvent.click(submit);
    await waitFor(() => expect(createExemption).toHaveBeenCalledWith({
      ruleId: 'r9', entityType: 'plugin', entityId: 'pipe-7', entityName: undefined, reason: 'Legacy build',
    }));
    expect(pageToast.success).toHaveBeenCalledWith('Exemption requested');
  });

  it('a refused request says so', async () => {
    createExemption.mockResolvedValue({ success: false, message: 'Rule not found' });
    render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.click(screen.getByRole('button', { name: /Request/ }));
    fireEvent.change(screen.getByLabelText('Rule ID'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByLabelText('Entity ID'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Reason for exemption'), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    await waitFor(() => expect(pageToast.error).toHaveBeenCalledWith('Rule not found'));
  });

  it('approves, and rejects with a reason', async () => {
    render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(reviewExemption).toHaveBeenCalledWith('ex1', 'approved'));
    await waitFor(() => expect(getExemptions).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText('Reason for rejection (optional)'), { target: { value: 'Too broad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Reject' }));
    await waitFor(() => expect(reviewExemption).toHaveBeenCalledWith('ex1', 'rejected', 'Too broad'));
  });

  it('read-only hides every write control', async () => {
    render(<ExemptionManager readOnly />);
    await screen.findByText('trivy-scan');
    for (const name of ['Approve', 'Reject', 'Delete', 'Import CSV']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('delete asks first, then deletes', async () => {
    render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteExemption).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(deleteExemption).toHaveBeenCalledWith('ex1'));
  });

  it('bulk import refuses a bad entityType instead of coercing it to plugin', async () => {
    const { container } = render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.change(fileInput(container), { target: { files: [csvFile('ruleId,entityType,entityId,reason\nr1,Pipeline ,p1,why\nr2,widget,p2,why\n')] } });
    expect(await screen.findByText(/entityType must be "plugin" or "pipeline" — check row\(s\) 3/)).toBeInTheDocument();
    expect(bulkCreateExemptions).not.toHaveBeenCalled();
  });

  it('bulk import names missing columns', async () => {
    const { container } = render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.change(fileInput(container), { target: { files: [csvFile('ruleId,entityId\nr1,p1\n')] } });
    expect(await screen.findByText(/Missing required column\(s\): entityType, reason/)).toBeInTheDocument();
  });

  it('bulk import sends trimmed, case-folded rows and reports the result', async () => {
    const { container } = render(<ExemptionManager />);
    await screen.findByText('trivy-scan');
    fireEvent.change(fileInput(container), { target: { files: [csvFile('ruleId,entityType,entityId,reason,entityName\n r1 ,PIPELINE,p1, why ,\nr2,plugin,p2,because,Lint\n')] } });
    await waitFor(() => expect(bulkCreateExemptions).toHaveBeenCalledWith([
      { ruleId: 'r1', entityType: 'pipeline', entityId: 'p1', entityName: undefined, reason: 'why', expiresAt: undefined },
      { ruleId: 'r2', entityType: 'plugin', entityId: 'p2', entityName: 'Lint', reason: 'because', expiresAt: undefined },
    ]));
    expect(await screen.findByText(/Imported/)).toHaveTextContent('Imported 2 exemptions');
  });
  describe('extend expiry', () => {
    const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const approved = (over: Record<string, unknown> = {}) => exemption({ status: 'approved', expiresAt: FUTURE, ...over });

    it('offers Extend expiry only on an approved, unlapsed exemption that has an expiry', async () => {
      getExemptions.mockResolvedValue(page([
        approved({ id: 'a', entityName: 'live' }),
        approved({ id: 'b', entityName: 'lapsed', expiresAt: '2020-01-01T00:00:00Z' }),
        approved({ id: 'c', entityName: 'open-ended', expiresAt: undefined }),
        exemption({ id: 'd', entityName: 'pending-one', expiresAt: FUTURE }),
      ]));
      render(<ExemptionManager />);
      await screen.findByText('live');
      expect(screen.getAllByRole('button', { name: 'Extend expiry' })).toHaveLength(1);
    });

    it('is hidden read-only', async () => {
      getExemptions.mockResolvedValue(page([approved()]));
      render(<ExemptionManager readOnly />);
      await screen.findByText('trivy-scan');
      expect(screen.queryByRole('button', { name: 'Extend expiry' })).not.toBeInTheDocument();
    });

    it('sends the END of the chosen local day and refreshes', async () => {
      getExemptions.mockResolvedValue(page([approved()]));
      extendExemptionExpiry.mockResolvedValue({ success: true, data: { exemption: approved() } });
      render(<ExemptionManager />);
      await screen.findByText('trivy-scan');
      fireEvent.click(screen.getByRole('button', { name: 'Extend expiry' }));
      const save = screen.getByRole('button', { name: 'Save expiry' });
      expect(save).toBeDisabled();
      fireEvent.change(screen.getByLabelText('New expiry date'), { target: { value: '2099-06-30' } });
      fireEvent.click(save);
      await waitFor(() => expect(extendExemptionExpiry).toHaveBeenCalledWith('ex1', localDayEndIso('2099-06-30')));
      expect(pageToast.success).toHaveBeenCalledWith('Exemption expiry extended');
      await waitFor(() => expect(getExemptions).toHaveBeenCalledTimes(2));
      expect(screen.queryByLabelText('New expiry date')).not.toBeInTheDocument();
    });

    it("shows the server's refusal in place and keeps the form open", async () => {
      getExemptions.mockResolvedValue(page([approved()]));
      extendExemptionExpiry.mockRejectedValue(new ApiError('You cannot extend an exemption you requested', 400, 'INSUFFICIENT_PERMISSIONS'));
      render(<ExemptionManager />);
      await screen.findByText('trivy-scan');
      fireEvent.click(screen.getByRole('button', { name: 'Extend expiry' }));
      fireEvent.change(screen.getByLabelText('New expiry date'), { target: { value: '2099-06-30' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save expiry' }));
      expect(await screen.findByText(/cannot extend an exemption you requested/)).toBeInTheDocument();
      expect(screen.getByLabelText('New expiry date')).toBeInTheDocument();
    });
  });
});
