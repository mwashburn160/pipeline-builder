// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Moved pages forward from `next.config.js`, not from client-side shim pages.
 *
 * `/dashboard/tokens` and `/dashboard/admin/alert-destinations` used to be pages
 * whose only job was a `router.replace` after the whole dashboard bundle and the
 * auth round-trip had loaded. Neither address carries a gate of its own (the
 * destination enforces its own), so they are server redirects now and the page
 * files are gone. `/dashboard/settings/service-accounts` deliberately stays a
 * page: it tells a viewer without `service_accounts:manage` why, instead of
 * bouncing them to a tab that won't render.
 *
 * Next's matcher is reproduced minimally here (first match wins; `has` query
 * conditions; the destination's own query beats the incoming one) so the table
 * is checked as Next would read it.
 */

import { describe, it, expect } from '@jest/globals';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCESS_KEYS_HREF, SESSIONS_HREF } from '../src/lib/security-links';
import { declaredPagePaths } from '../src/lib/page-access';

interface Redirect {
  source: string;
  destination: string;
  permanent: boolean;
  has?: { type: string; key: string; value?: string }[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../next.config.js') as { redirects: () => Promise<Redirect[]> };

/** Where Next would send `pathname?query` — null when no rule matches. */
async function resolveRedirect(pathname: string, query: Record<string, string> = {}): Promise<string | null> {
  const rules = await nextConfig.redirects();
  const rule = rules.find((r) => r.source === pathname
    && (r.has ?? []).every((h) => h.type === 'query' && query[h.key] !== undefined && (h.value === undefined || query[h.key] === h.value)));
  if (!rule) return null;
  const [pathAndQuery, hash] = rule.destination.split('#');
  const [path, search = ''] = pathAndQuery.split('?');
  const merged = { ...query, ...Object.fromEntries(new URLSearchParams(search)) };
  const qs = new URLSearchParams(merged).toString();
  return `${path}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`;
}

const PAGES = resolve(__dirname, '../pages/dashboard');

describe('the old API Tokens address', () => {
  it('sends the default and ?tab=tokens to Security → Access keys', async () => {
    expect(await resolveRedirect('/dashboard/tokens')).toBe(ACCESS_KEYS_HREF);
    expect(await resolveRedirect('/dashboard/tokens', { tab: 'tokens' })).toBe(ACCESS_KEYS_HREF);
  });

  it('sends the old sessions tab to the ONE sessions view', async () => {
    expect(await resolveRedirect('/dashboard/tokens', { tab: 'sessions' })).toBe(SESSIONS_HREF);
  });

  it('sends the decoded-token tab to the section that now holds it', async () => {
    expect(await resolveRedirect('/dashboard/tokens', { tab: 'access' })).toBe(`${SESSIONS_HREF}#current-token`);
  });

  it('has no page file behind it any more, and no page gate', () => {
    expect(existsSync(resolve(PAGES, 'tokens.tsx'))).toBe(false);
    expect(declaredPagePaths()).not.toContain('/dashboard/tokens');
  });
});

describe('the old sysadmin alert-destinations address', () => {
  it('lands on the one destinations page in its all-organizations mode', async () => {
    // `?all=1` is honoured only for sysadmins by the destination page, so the
    // same static rule is right for everyone.
    expect(await resolveRedirect('/dashboard/admin/alert-destinations'))
      .toBe('/dashboard/observability/alert-destinations?all=1');
  });

  it('has no page file behind it any more, and no page gate', () => {
    expect(existsSync(resolve(PAGES, 'admin/alert-destinations.tsx'))).toBe(false);
    expect(declaredPagePaths()).not.toContain('/dashboard/admin/alert-destinations');
  });
});

describe('gated moves stay pages', () => {
  it('does not redirect the service-accounts address from config (it keeps its permission gate)', async () => {
    expect(await resolveRedirect('/dashboard/settings/service-accounts')).toBeNull();
    expect(existsSync(resolve(PAGES, 'settings/service-accounts.tsx'))).toBe(true);
  });

  it('every redirect is permanent and points inside the app', async () => {
    for (const r of await nextConfig.redirects()) {
      expect(r.permanent).toBe(true);
      expect(r.destination.startsWith('/')).toBe(true);
    }
  });
});
