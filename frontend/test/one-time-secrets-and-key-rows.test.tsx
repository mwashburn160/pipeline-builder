// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two pieces that were copied instead of shared.
 *
 * 1. ONE-TIME SECRETS. The recovery-codes sheet offered copy, download and an
 *    "I've saved them" acknowledgement; the access-key / service-account-key /
 *    machine-token / SCIM-key / webhook-token reveals offered Copy alone — so
 *    the values that are genuinely unrecoverable were the ones a person could
 *    scroll past. Both now render the same {@link SecretActions} row.
 *
 * 2. KEY ROWS. `pb_pat_…` and `pb_sa_…` are the same object with the same
 *    lifecycle, but the service-accounts page hand-rolled a row of spans that
 *    omitted the never-used and expiring-soon flags. One {@link AccessKeyTable}
 *    now renders both.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { SecretReveal } from '../src/components/ui/SecretReveal';
import { RecoveryCodes } from '../src/components/settings/RecoveryCodes';
import { AccessKeyTable, type KeyRow } from '../src/components/settings/AccessKeyTable';

const DAY = 86_400_000;

function key(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    id: 'k1',
    name: 'ci-deploy',
    prefix: 'pb_pat',
    display: 'pb_pat_…a1b2',
    kind: 'personal',
    serviceAccountId: null,
    serviceAccountName: null,
    scope: null,
    organizationId: 'org-1',
    ipAllowlist: null,
    createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    expiresAt: new Date(Date.now() + 90 * DAY).toISOString(),
    lastUsedAt: new Date(Date.now() - DAY).toISOString(),
    createdFrom: null,
    createdIp: null,
    revoked: false,
    status: 'active',
    neverUsed: false,
    expiringSoon: false,
    ...overrides,
  } as KeyRow;
}

describe('one-time secrets offer the same three actions everywhere', () => {
  it('a revealed key can be copied, downloaded and acknowledged', () => {
    const onDone = jest.fn();
    render(<SecretReveal value="pb_pat_SECRET" label="Access key" onDone={onDone} filename="key.txt" />);

    expect(screen.getByText('pb_pat_SECRET')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('download', 'key.txt');

    // The acknowledgement is what dismisses it — not the next render.
    fireEvent.click(screen.getByRole('button', { name: /saved it/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('recovery codes use the same row, so the two cannot drift apart', () => {
    const onDone = jest.fn();
    render(<RecoveryCodes codes={['AAAAA-BBBBB', 'CCCCC-DDDDD']} onDone={onDone} />);

    expect(screen.getByRole('link', { name: /download/i }))
      .toHaveAttribute('download', 'pipeline-builder-recovery-codes.txt');
    fireEvent.click(screen.getByRole('button', { name: /saved them/i }));
    expect(onDone).toHaveBeenCalled();
  });

  it('omits the acknowledgement only where there is nothing to dismiss', () => {
    render(<SecretReveal value="pb_pat_SECRET" label="Access key" />);
    expect(screen.queryByRole('button', { name: /saved it/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
  });
});

describe('every access key is reviewed the same way', () => {
  it('shows the hygiene flags an audit asks about', () => {
    render(<AccessKeyTable keys={[key({ neverUsed: true, lastUsedAt: null, expiringSoon: true })]} readOnly={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/never used/)).toBeInTheDocument();
    expect(screen.getByText(/expiring soon/)).toBeInTheDocument();
  });

  it('names the narrowing on a machine key — scope AND IP allowlist', () => {
    render(<AccessKeyTable
      keys={[key({ prefix: 'pb_sa', display: 'pb_sa_…c3d4', kind: 'service_account', scope: 'scim', ipAllowlist: ['203.0.113.7'] })]}
      readOnly={false}
      onRevoke={jest.fn()}
    />);
    expect(screen.getByText('scim')).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.7/)).toBeInTheDocument();
  });

  it('labels the owning account only where the row needs the context', () => {
    const saKey = key({ kind: 'service_account', serviceAccountName: 'ci-deploy' });
    const { rerender } = render(<AccessKeyTable keys={[saKey]} readOnly={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/service account: ci-deploy/)).toBeInTheDocument();

    // Inside the account's own card the owner is the heading above it.
    rerender(<AccessKeyTable keys={[saKey]} readOnly={false} showOwner={false} onRevoke={jest.fn()} />);
    expect(screen.queryByText(/service account: ci-deploy/)).not.toBeInTheDocument();
  });

  it('asks the caller to revoke — the confirmation is theirs', () => {
    const onRevoke = jest.fn();
    render(<AccessKeyTable keys={[key()]} readOnly={false} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'k1' }));
  });

  it('offers no revoke for a key that is already dead', () => {
    render(<AccessKeyTable keys={[key({ status: 'revoked', revoked: true })]} readOnly={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('disables revoking under read-only impersonation', () => {
    render(<AccessKeyTable keys={[key()]} readOnly onRevoke={jest.fn()} />);
    expect(screen.getByRole('button', { name: /revoke/i })).toBeDisabled();
  });

  it('shows an empty state rather than a bare sentence', () => {
    render(<AccessKeyTable keys={[]} readOnly={false} onRevoke={jest.fn()} emptyTitle="No keys yet" emptyDescription="Issue one above." />);
    const empty = screen.getByText('No keys yet').closest('div')!;
    expect(within(empty).getByText('No keys yet')).toBeInTheDocument();
  });
});
