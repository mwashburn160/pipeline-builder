// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** RecipientPicker labels account teams ("Team") in the org dropdown. */

import { it, expect, jest } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RecipientPicker } from '../src/components/message/RecipientPicker';

it('marks team options with a Team label and leaves the root unmarked', () => {
  render(
    <RecipientPicker
      supportAlias="support@x.io"
      teamOptions={[
        { value: 'root-1', label: 'Acme' },
        { value: 'team-2', label: 'Platform', isTeam: true },
      ]}
      recipientOrgId=""
      onRecipientOrgIdChange={jest.fn<AnyFn>()}
      recipientUserId=""
      onRecipientUserIdChange={jest.fn<AnyFn>()}
      fetchMembers={jest.fn<AnyFn>(async () => [])}
    />,
  );

  fireEvent.focus(screen.getByLabelText('Recipient team or organization'));
  const listbox = screen.getByRole('listbox', { name: 'Teams' });
  expect(within(listbox).getByRole('option', { name: /platform/i })).toHaveTextContent(/team/i);
  expect(within(listbox).getByRole('option', { name: /acme/i })).not.toHaveTextContent(/team/i);
});

it('drops the "Searching" state when the query is shortened mid-search', async () => {
  const searchTeams = jest.fn<AnyFn>(() => new Promise(() => {}));
  render(
    <RecipientPicker
      supportAlias="support@x.io"
      teamOptions={[{ value: 'root-1', label: 'Acme' }]}
      recipientOrgId=""
      onRecipientOrgIdChange={jest.fn<AnyFn>()}
      recipientUserId=""
      onRecipientUserIdChange={jest.fn<AnyFn>()}
      fetchMembers={jest.fn<AnyFn>(async () => [])}
      searchTeams={searchTeams as never}
    />,
  );
  const input = screen.getByLabelText('Recipient team or organization');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'zz' } });
  expect(await screen.findByText('Searching organizations…')).toBeInTheDocument();

  // One character is below the search threshold: the pending search is
  // abandoned, so the dropdown must say what to do instead of spinning forever.
  fireEvent.change(input, { target: { value: 'z' } });
  await waitFor(() => expect(screen.getByText(/no matching organizations/i)).toBeInTheDocument());
  expect(searchTeams).toHaveBeenCalledTimes(1);
});
