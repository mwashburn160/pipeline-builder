// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Support contacts card (Settings → Support contacts).
 *
 * Regression: the card rendered the roster only while `!read.loading`, so every
 * background re-read — a write's refetch, a tagged roster invalidation — blanked
 * the whole section to a spinner and back. The spinner is for the FIRST load
 * only; once a roster is on screen it stays there while the re-read is out.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SupportContactSettings } from '../src/components/settings/SupportContactSettings';

const listSupportContacts = jest.fn<AnyFn>();
const removeSupportContact = jest.fn<AnyFn>();
const listAllOrgMembers = jest.fn<AnyFn>();

jest.mock('@/lib/api', () => ({
  __esModule: true,
  ApiError: class ApiError extends Error { statusCode = 0; },
  default: {
    listSupportContacts: (...a: unknown[]) => listSupportContacts(...a),
    removeSupportContact: (...a: unknown[]) => removeSupportContact(...a),
    addSupportContact: jest.fn(),
    setSupportContactLevel: jest.fn(),
  },
}));
jest.mock('@/lib/list-all', () => ({
  __esModule: true,
  listAllOrgMembers: (...a: unknown[]) => listAllOrgMembers(...a),
}));
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({
  success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn(),
})));

const contacts = (names: string[]) => ({
  level: 'support_standard',
  limit: 5,
  used: names.length,
  premium: false,
  premiumLimit: 0,
  premiumUsed: 0,
  canUpgrade: false,
  canDesignate: true,
  contacts: names.map((n) => ({ userId: `u-${n}`, username: n, email: `${n}@example.com`, isPremium: false })),
});

beforeEach(() => {
  listSupportContacts.mockReset();
  removeSupportContact.mockReset();
  listAllOrgMembers.mockReset().mockResolvedValue([]);
});

describe('SupportContactSettings', () => {
  it('shows a spinner (and no roster) on the first load', async () => {
    listSupportContacts.mockReturnValue(new Promise(() => { /* never settles */ }));
    render(<SupportContactSettings orgId="org-1" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('alice')).not.toBeInTheDocument();
  });

  it('keeps the current roster on screen (no spinner) while a write\'s refetch is in flight', async () => {
    listSupportContacts
      .mockResolvedValueOnce({ success: true, data: contacts(['alice', 'bob']) })
      // The refetch after the remove: hold it open so the in-flight state is observable.
      .mockReturnValueOnce(new Promise(() => { /* never settles */ }));
    removeSupportContact.mockResolvedValue({ success: true, data: { openCases: [] } });

    render(<SupportContactSettings orgId="org-1" />);
    expect(await screen.findByText('alice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove bob as a support contact' }));
    await waitFor(() => expect(listSupportContacts).toHaveBeenCalledTimes(2));

    // The re-read is out: the section must not blank to the first-load spinner.
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  });
});
