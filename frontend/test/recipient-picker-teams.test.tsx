// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** RecipientPicker labels account teams ("Team") in the org dropdown. */

import { fireEvent, render, screen, within } from '@testing-library/react';
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
      onRecipientOrgIdChange={jest.fn()}
      recipientUserId=""
      onRecipientUserIdChange={jest.fn()}
      fetchMembers={jest.fn(async () => [])}
    />,
  );

  fireEvent.focus(screen.getByLabelText('Recipient team or organization'));
  const listbox = screen.getByRole('listbox', { name: 'Teams' });
  expect(within(listbox).getByRole('option', { name: /platform/i })).toHaveTextContent(/team/i);
  expect(within(listbox).getByRole('option', { name: /acme/i })).not.toHaveTextContent(/team/i);
});
