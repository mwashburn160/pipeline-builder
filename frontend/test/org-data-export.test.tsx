// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An org's own admin can export its data from Settings (the endpoint was only
 * reachable from the sysadmin console and team cards).
 */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const exportOrganization = jest.fn<AnyFn>(async () => '{"org":{}}');
jest.mock('@/lib/api', () => ({ __esModule: true, default: { exportOrganization: (...a: unknown[]) => exportOrganization(...a) } }));
const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({ __esModule: true, triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a) }));

import { OrgDataExport } from '../src/components/settings/OrgDataExport';

it('downloads the org export as a named JSON file', async () => {
  render(<OrgDataExport orgId="org-1" orgName="Acme Corp" />);
  fireEvent.click(screen.getByRole('button', { name: /download export/i }));
  await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(expect.any(Blob), 'org-acme-corp-export.json'));
  expect(exportOrganization).toHaveBeenCalledWith('org-1');
  expect(screen.getByText('Export downloaded.')).toBeInTheDocument();
});

it('shows a refused export', async () => {
  exportOrganization.mockRejectedValueOnce(new Error('Failed to export organization: 403 Forbidden'));
  render(<OrgDataExport orgId="org-1" />);
  fireEvent.click(screen.getByRole('button', { name: /download export/i }));
  expect(await screen.findByText(/403 Forbidden/)).toBeInTheDocument();
});
