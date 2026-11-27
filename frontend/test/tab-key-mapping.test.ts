// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A merged page owns `?tab=`, so a tab body that had its own `?tab=` reads a
 * different key now: Messages' view filter is `?view=`, Billing's sections are
 * `?section=`. Links into either point at the new key on the merged page.
 */
import { describe, it, expect } from '@jest/globals';
import { parseInboxQuery } from '../src/hooks/useInboxQuery';
import { featureUpsellHref } from '../src/lib/feature-gates';
import { billingHref, BILLING_HREF, QUOTAS_HREF, MESSAGES_HREF, ACCESS_REQUESTS_HREF, ROLES_HREF, INVITATIONS_HREF, TEAMS_HREF, messageHref, invitationsHref } from '../src/lib/tabbed-pages';

describe('Messages reads its view from ?view=', () => {
  it('parses the view key and leaves the page tab alone', () => {
    expect(parseInboxQuery({ tab: 'messages', view: 'conversations' }).tab).toBe('conversations');
    expect(parseInboxQuery({ tab: 'announcements' }).tab).toBe('all');
  });
});

describe('canonical hrefs', () => {
  it('names the merged page and its tab', () => {
    expect(BILLING_HREF).toBe('/dashboard/usage?tab=billing');
    expect(QUOTAS_HREF).toBe('/dashboard/usage?tab=quotas');
    expect(MESSAGES_HREF).toBe('/dashboard/inbox?tab=messages');
    expect(ACCESS_REQUESTS_HREF).toBe('/dashboard/inbox?tab=access-requests');
    expect(ROLES_HREF).toBe('/dashboard/members?tab=roles');
    expect(INVITATIONS_HREF).toBe('/dashboard/members?tab=invitations');
    expect(TEAMS_HREF).toBe('/dashboard/members?tab=teams');
  });

  it('builds billing deep links on ?section= and ?highlight=', () => {
    expect(billingHref({ section: 'plans' })).toBe('/dashboard/usage?tab=billing&section=plans');
    expect(billingHref({ highlight: 'advanced_reporting' })).toBe('/dashboard/usage?tab=billing&highlight=advanced_reporting');
    expect(billingHref({ section: 'addons', highlight: 'sso' })).toBe('/dashboard/usage?tab=billing&section=addons&highlight=sso');
  });

  it('builds message and invitation deep links', () => {
    expect(messageHref('t 1')).toBe('/dashboard/inbox?tab=messages&message=t%201');
    expect(invitationsHref('a@b.io')).toBe('/dashboard/members?tab=invitations&email=a%40b.io');
  });

  it('sends upsells to the billing tab', () => {
    expect(featureUpsellHref('sso')).toBe('/dashboard/usage?tab=billing&section=plans');
    expect(featureUpsellHref('advanced_reporting')).toBe('/dashboard/usage?tab=billing&highlight=advanced_reporting');
  });
});
