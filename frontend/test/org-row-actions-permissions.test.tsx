// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The org row menu offers the LIFECYCLE actions only to `orgs:manage`.
 *
 * Why this test exists: the All Organizations page is reached on `orgs:read`,
 * which was split out of `platform:read` so the read-only job Roles could find
 * an org by name. Four of the five seeded job Roles — Platform Observer,
 * Console Administrator, Support Agent, Platform Operator — hold that read
 * WITHOUT `orgs:manage`. Until 2026-11-10 this menu rendered "Delete
 * organization" and the tier item for all of them, and the server answered 403:
 * the role whose stated purpose is "looks and changes nothing" was offered a
 * button that deletes a customer.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react';
import { RowActionsMenu } from '../src/components/organizations/RowActionsMenu';

const open = (canManage: boolean) => {
  render(
    <RowActionsMenu
      canKms={false}
      canIdp={false}
      canManage={canManage}
      onKms={jest.fn()}
      onIdp={jest.fn()}
      onTier={jest.fn()}
      onNamespace={jest.fn()}
      onDelete={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /more actions/i }));
};

describe('org row actions — the lifecycle half needs orgs:manage', () => {
  it('offers delete and tier to a holder', () => {
    open(true);
    expect(screen.getByRole('menuitem', { name: /delete organization/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /tier/i })).toBeInTheDocument();
  });

  it('offers NEITHER to orgs:read alone (a Platform Observer)', () => {
    open(false);
    expect(screen.queryByRole('menuitem', { name: /delete organization/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /tier/i })).not.toBeInTheDocument();
    // The read-only actions stay: finding an org and reading it is the whole
    // point of the permission that got them here.
    expect(screen.getByRole('menuitem', { name: /namespace yaml/i })).toBeInTheDocument();
  });
});
