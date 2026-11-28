// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Members (`/dashboard/members?tab=…`), as an org owner whose org parents a
 * team: each of the four tabs renders the stubbed roster, teams, Roles and
 * invitations, switching tabs moves `?tab=`, and on Invitations an invite is
 * sent (one request carrying every address, the role and the type) and a
 * pending invitation is revoked through its confirmation dialog.
 */

import { test, expect } from '@playwright/test';
import { signedInPage } from './support/backend';
import { OWNER_WITH_TEAM, stubMembers } from './support/fixtures/members';

test('the four Members tabs render their data and keep ?tab= in step', async ({ page }) => {
  const api = await signedInPage(page, OWNER_WITH_TEAM);
  stubMembers(api);
  await page.goto('/dashboard/members');

  const tabs = page.getByRole('tablist', { name: 'Member sections' });
  await expect(tabs.getByRole('tab')).toHaveText(['Members', 'Teams', 'Roles', 'Invitations']);

  // Members: the roster with Roles and status, and the seat usage.
  const members = page.getByRole('tabpanel', { name: 'Members' });
  await expect(members.getByRole('row', { name: /^eli eli@example\.test member Developers Active/ })).toBeVisible();
  await expect(members.getByRole('row', { name: /^fran fran@example\.test admin No roles Inactive/ })).toBeVisible();
  await expect(members.getByRole('button', { name: 'Reactivate fran' })).toBeVisible();
  await expect(members.getByText('of 25 account seats used')).toBeVisible();

  // Teams.
  await tabs.getByRole('tab', { name: 'Teams' }).click();
  await expect(page).toHaveURL(/[?&]tab=teams/);
  const teams = page.getByRole('tabpanel', { name: 'Teams' });
  await expect(teams.getByRole('heading', { name: 'Teams (1)' })).toBeVisible();
  await expect(teams.getByRole('button', { name: 'Open Payments team' })).toBeVisible();

  // Roles: seeded Roles are not editable, a custom one is.
  await tabs.getByRole('tab', { name: 'Roles' }).click();
  await expect(page).toHaveURL(/[?&]tab=roles/);
  const roles = page.getByRole('tabpanel', { name: 'Roles' });
  await expect(roles.getByRole('heading', { name: /^Administrators/ })).toBeVisible();
  await expect(roles.getByRole('button', { name: 'Remove eli from Developers' })).toBeVisible();
  await expect(roles.getByRole('button', { name: 'Edit Release managers' })).toBeVisible();
  await expect(roles.getByRole('button', { name: 'Edit Administrators' })).toHaveCount(0);

  // Invitations.
  await tabs.getByRole('tab', { name: 'Invitations' }).click();
  await expect(page).toHaveURL(/[?&]tab=invitations/);
  const invitations = page.getByRole('tabpanel', { name: 'Invitations' });
  await expect(invitations.getByRole('row', { name: /gale@example\.test member pending dana/ })).toBeVisible();
  await expect(invitations.getByRole('row', { name: /hal@example\.test member accepted dana/ })).toBeVisible();

  // Back to Members by URL: the tab follows the query.
  await page.goto('/dashboard/members?tab=roles');
  await expect(page.getByRole('tab', { name: 'Roles' })).toHaveAttribute('aria-selected', 'true');
  expect(api.pageErrors).toEqual([]);
});

test.describe('invitations', () => {
  // The send dialog is taller than a 720px viewport and a non-`tall` Modal
  // neither caps its height nor lets the backdrop scroll, so its footer is out
  // of reach there (reported to the product owner); a laptop-height viewport
  // is what this journey needs.
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('send invitations, then revoke a pending one', async ({ page }) => {
    const api = await signedInPage(page, OWNER_WITH_TEAM);
    stubMembers(api);
    await page.goto('/dashboard/members?tab=invitations');
    const panel = page.getByRole('tabpanel', { name: 'Invitations' });
    await expect(panel.getByRole('row', { name: /gale@example\.test/ })).toBeVisible();

    // Invite: two addresses (one duplicated, one upper-cased) as an admin, email only.
    await page.getByRole('button', { name: 'Send Invitation' }).click();
    const compose = page.getByRole('dialog', { name: 'Send invitations' });
    await compose.getByLabel('Email(s)').fill('Ivy@Example.test, jo@example.test\nivy@example.test');
    await expect(compose.getByText('Will send to 2 addresses.')).toBeVisible();
    await compose.getByLabel('Role', { exact: true }).selectOption('admin');
    await compose.getByLabel('Invitation type').selectOption('email');
    await compose.getByRole('button', { name: 'Send', exact: true }).click();

    await expect.poll(() => api.calls('POST /api/invitation/send').length).toBe(1);
    expect(api.calls('POST /api/invitation/send')[0].json).toEqual({
      emails: ['ivy@example.test', 'jo@example.test'], role: 'admin', invitationType: 'email',
    });
    await expect(compose.getByText('Sent 2.')).toBeVisible();
    // A clean send closes itself, and the list re-reads with the new rows.
    await expect(compose).toBeHidden();
    await expect(panel.getByRole('row', { name: /ivy@example\.test member pending/ })).toBeVisible();
    await expect(panel.getByRole('row', { name: /jo@example\.test member pending/ })).toBeVisible();

    // Revoke the original pending invitation; cancel first, then confirm.
    const gale = panel.getByRole('row', { name: /gale@example\.test/ });
    await gale.getByRole('button', { name: 'Revoke' }).click();
    const confirm = page.getByRole('dialog', { name: 'Revoke invitation' });
    await expect(confirm.getByText('gale@example.test')).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    expect(api.calls('DELETE /api/invitation/inv-1')).toHaveLength(0);

    await gale.getByRole('button', { name: 'Revoke' }).click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => api.calls('DELETE /api/invitation/inv-1').length).toBe(1);
    await expect(page.getByText('Invitation to gale@example.test revoked')).toBeVisible();
    await expect(confirm).toBeHidden();
    // The re-read shows it revoked, no longer selectable or revocable.
    await expect(gale).toContainText('revoked');
    await expect(gale.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    expect(api.pageErrors).toEqual([]);
  });
});
