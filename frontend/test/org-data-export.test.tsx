// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's own admin can export its data from Settings (the endpoint was only
 * reachable from the sysadmin console and team cards). The export is step-up
 * gated server-side (a bulk read of every row the org owns), so the button
 * opens the step-up dialog and the download carries its token.
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const exportOrganization = jest.fn<AnyFn>(async () => '{"org":{}}');
jest.mock('@/lib/api', () => ({ __esModule: true, default: { exportOrganization: (...a: unknown[]) => exportOrganization(...a) } }));
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));
jest.mock('@/components/admin/StepUpModal', () => ({
  __esModule: true,
  StepUpModal: ({ action, title, onConfirmed }: { action: string; title?: string; onConfirmed: (t: string) => void }) => (
    <div role="dialog" aria-label={title ?? 'step-up'}>
      <p>{action}</p>
      <button type="button" onClick={() => onConfirmed('step-up-token')}>Verify</button>
    </div>
  ),
}));

import { OrgDataExport } from '../src/components/settings/OrgDataExport';

it('asks for a step-up first, then downloads the org export with its token as a named JSON file', async () => {
  render(<OrgDataExport orgId="org-1" orgName="Acme Corp" />);
  fireEvent.click(screen.getByRole('button', { name: /download export/i }));
  expect(exportOrganization).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), 'org-acme-corp-export.json'));
  expect(exportOrganization).toHaveBeenCalledWith('org-1', 'step-up-token');
  expect(screen.getByText('Export downloaded.')).toBeInTheDocument();
});

it('shows a refused export', async () => {
  exportOrganization.mockRejectedValueOnce(new Error('Failed to export organization: 403 Forbidden'));
  render(<OrgDataExport orgId="org-1" />);
  fireEvent.click(screen.getByRole('button', { name: /download export/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  expect(await screen.findByText(/403 Forbidden/)).toBeInTheDocument();
});
