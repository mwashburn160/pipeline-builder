// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Inbox's three tabs against the stubbed sources (support/fixtures/inbox.ts),
 * with the page clock pinned so relative times are stable:
 *  - Notifications aggregates a failing pipeline the viewer owns, a pending
 *    exemption, a plugin security fix and the unread-messages summary — most
 *    severe first — and the summary opens the Messages tab;
 *  - Messages lists the conversation and the announcement; opening the unread
 *    conversation shows its thread, marks it read, and a reply is posted to it;
 *  - Access requests lists the request waiting for the viewer and the live
 *    session; approving restates the grant before deciding, and ending the
 *    session asks once.
 */

import { test, expect } from '@playwright/test';
import { signedInPage } from './support/backend';
import { ACCESS_REQUEST, CONVERSATION, INBOX_NOW, LIVE_SESSION, REPLY, stubInbox } from './support/fixtures/inbox';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(INBOX_NOW);
});

test('Notifications lists the action items by severity and the unread summary opens Messages', async ({ page }) => {
  const api = await signedInPage(page);
  stubInbox(api);
  await page.goto('/dashboard/inbox');

  const panel = page.getByRole('tabpanel', { name: 'Notifications' });
  await expect(page.getByRole('tab', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('heading', { name: '4 action items' })).toBeVisible();
  const items = panel.getByRole('listitem');
  await expect(items).toHaveText([
    /acme-web-pipeline has 3 failed runs/,
    /Exemption request pending review \(pipeline\)/,
    /Security fix for node-build 2\.3\.0 is awaiting approval/,
    /1 unread message/,
  ]);
  await expect(panel.getByRole('link', { name: /acme-web-pipeline has 3 failed runs/ })).toHaveAttribute('href', '/dashboard/pipelines/pl-web');
  // Only the exemptions awaiting a decision, and only the remediation stages that ask someone.
  expect(api.calls('GET /api/compliance/exemptions')[0].query.get('status')).toBe('pending');
  expect(api.calls('GET /api/plugins/remediations')[0].query.get('stage')).toBe('awaiting_approval,needs_owner,needs_review,rolling_out');

  await panel.getByRole('link', { name: /1 unread message/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/inbox\?tab=messages/);
  await expect(page.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
  expect(api.pageErrors).toEqual([]);
});

test('Messages opens the unread conversation, marks it read and sends a reply', async ({ page }) => {
  const api = await signedInPage(page);
  stubInbox(api);
  await page.goto('/dashboard/inbox?tab=messages');

  const panel = page.getByRole('tabpanel', { name: 'Messages' });
  // Each row opens through its own button, named by what the row shows; its
  // select checkbox sits beside it, not inside it.
  const conversation = panel.getByRole('button', { name: new RegExp(CONVERSATION.content.slice(0, 40)) });
  await expect(conversation).toContainText('Unread');
  await expect(panel.getByRole('checkbox', { name: `Select message: ${CONVERSATION.subject}` })).toBeVisible();
  await expect(panel.getByRole('button', { name: /The build queue pauses for 30 minutes/ })).toContainText('Announcement');

  await conversation.click();
  await expect(page).toHaveURL(new RegExp(`[?&]message=${CONVERSATION.id}`));
  await expect(panel.getByText(CONVERSATION.content)).toBeVisible();
  await expect(panel.getByText(REPLY.content)).toBeVisible();
  await expect.poll(() => api.calls(`PUT /api/messages/${CONVERSATION.id}/thread/read`).length).toBeGreaterThan(0);
  await expect(conversation).not.toContainText('Unread');

  const reply = panel.getByRole('textbox', { name: 'Reply to conversation' });
  const send = panel.getByRole('button', { name: 'Send reply' });
  await expect(send).toBeDisabled();
  await reply.fill('Booked — thanks!');
  await send.click();
  await expect.poll(() => api.calls(`POST /api/messages/${CONVERSATION.id}/reply`).length).toBe(1);
  const sent = api.calls(`POST /api/messages/${CONVERSATION.id}/reply`)[0];
  expect(sent.json).toEqual({ content: 'Booked — thanks!' });
  expect(sent.headers['idempotency-key']).toBeTruthy();
  await expect(reply).toHaveValue('');
  expect(api.pageErrors).toEqual([]);
});

test('Access requests: approving restates the grant, and ending a live session asks once', async ({ page }) => {
  const api = await signedInPage(page);
  stubInbox(api);
  await page.goto('/dashboard/inbox?tab=access-requests');

  const panel = page.getByRole('tabpanel', { name: 'Access requests' });
  const request = panel.getByRole('listitem').filter({ hasText: 'Sam from Support wants to view your account' });
  await expect(request).toContainText(`Reason: “${ACCESS_REQUEST.reason}”`);
  await expect(request).toContainText('Asked 10 min. ago');
  await expect(panel.getByText('1 pending')).toBeVisible();

  await request.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve access?' });
  await expect(approve).toContainText('Sam from Support will be able to see your account exactly as it appears, for up to 15 minutes.');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toBeHidden();
  await expect.poll(() => api.calls(`POST /api/admin/impersonate/requests/${ACCESS_REQUEST.id}/decide`).length).toBe(1);
  expect(api.calls(`POST /api/admin/impersonate/requests/${ACCESS_REQUEST.id}/decide`)[0].json).toEqual({ approve: true });
  await expect(page.getByText('Request approved')).toBeVisible();
  await expect(panel.getByText('Nothing is waiting for you.')).toBeVisible();

  const session = panel.getByRole('listitem').filter({ hasText: `${LIVE_SESSION.requester.name} is viewing riley's account` });
  await session.getByRole('button', { name: 'End session' }).click();
  const end = page.getByRole('dialog', { name: 'End this session?' });
  await expect(end).toContainText("This can't be undone");
  await end.getByRole('button', { name: 'End session' }).click();
  await expect.poll(() => api.calls(`POST /api/admin/impersonate/requests/${LIVE_SESSION.id}/revoke`).length).toBe(1);
  await expect(page.getByText('Session ended')).toBeVisible();
  await expect(panel.getByText('No one is viewing an account right now.')).toBeVisible();
  expect(api.pageErrors).toEqual([]);
});
