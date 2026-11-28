// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stubbed backend every e2e spec runs against: one `page.route('**\/api/**')`
 * handler answering from a per-test table, so the suite needs no platform, no
 * database and no secrets — only `next dev`.
 *
 *   const api = await stubBackend(page);          // signed-out defaults
 *   api.on('POST /api/pipelines', (req) => ({ status: 201, json: { success: true, data: {} } }));
 *   …
 *   expect(api.calls('POST /api/pipelines')[0].json).toMatchObject({ … });
 *
 * Unknown endpoints answer `{ success: true }` (200) and are recorded in
 * `api.unhandled`, so a page that grows a new read keeps rendering while the
 * list says what a spec might want to stub.
 */

import { randomBytes } from 'node:crypto';
import type { Page, Request } from '@playwright/test';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../../packages/api-core/src/types/permissions';

export interface StubReply {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedCall {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  json: unknown;
}

type Handler = (call: RecordedCall, req: Request) => StubReply | Promise<StubReply>;

/** An unsigned JWT the client only DECODES (exp, org) — it never verifies. */
export function fakeJwt(claims: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u-1', organizationId: 'org-1', iat: now, exp: now + 3600, ...claims })}.sig`;
}

export const OWNER = {
  id: 'u-1',
  username: 'dana',
  email: 'dana@example.test',
  role: 'owner',
  organizationId: 'org-1',
  organizationName: 'Acme',
  isEmailVerified: true,
  tier: 'pro',
  features: [] as string[],
  permissions: [...ROLE_PERMISSIONS.owner],
  authFactors: { hasPassword: true, passkeyCount: 0, hasTotp: false, providers: [] as string[] },
  organizations: [{ organizationId: 'org-1', organizationName: 'Acme', role: 'owner', joinedAt: '2026-01-01T00:00:00Z', childOrgCount: 0 }],
};

/** The profile shape the stub serves (`isSuperAdmin` only on an operator). */
export type StubUser = typeof OWNER & { isSuperAdmin?: boolean };

/** The platform's own org: the Platform section's `systemOrgOnly` pages need it active. */
export const SYSTEM_ORG_ID = '000000000000000000000001';

/**
 * A platform operator: superadmin, active in the system org, holding every
 * permission — the user that sees every nav entry (Platform and its
 * sub-groups included). The a11y walk and the screenshot specs sign in as it.
 */
export const SYSADMIN: StubUser = {
  ...OWNER,
  id: 'u-sys',
  username: 'root',
  email: 'root@example.test',
  organizationId: SYSTEM_ORG_ID,
  organizationName: 'Platform',
  tier: 'enterprise',
  permissions: [...ALL_PERMISSIONS],
  authFactors: { hasPassword: true, passkeyCount: 1, hasTotp: true, providers: [] },
  organizations: [{ organizationId: SYSTEM_ORG_ID, organizationName: 'Platform', role: 'owner', joinedAt: '2026-01-01T00:00:00Z', childOrgCount: 0 }],
  isSuperAdmin: true,
};

/** `GET /config` — the deployment's public config, every field the real one sends. */
export const CONFIG = {
  serviceFeatures: {}, deployTarget: 'local', adminConsolesEnabled: false,
  supportAlias: 'support@example.test', supportAliases: ['support@example.test', 'billing@example.test'],
  askUiMode: 'ask-agent', cli: { npmPackage: '@pipeline-builder/cli', npmUrl: 'https://www.npmjs.com/package/@pipeline-builder/cli' },
};

/** Fixed reset date, so nothing derived from "now" renders differently per run. */
const RESET_AT = '2026-12-01T00:00:00.000Z';
const QUOTA_TYPES = ['plugins', 'pipelines', 'apiCalls', 'automationCalls', 'aiCalls', 'storageBytes', 'cpuCredits',
  'dashboards', 'alertRules', 'alertDestinations', 'idpConfigs', 'listings'] as const;

/** `GET /quota` — the org's own quota: modest usage of generous limits, no banner. */
export function quotaFor(user: StubUser) {
  const quotas = Object.fromEntries(QUOTA_TYPES.map((t, i) => {
    const limit = t === 'storageBytes' ? 10 * 1024 ** 3 : 1000;
    const used = t === 'storageBytes' ? 1024 ** 3 : (i + 1) * 7;
    return [t, { limit, used, remaining: limit - used, unlimited: false, resetAt: RESET_AT, periodDays: t === 'cpuCredits' ? 30 : 3 }];
  }));
  return { orgId: user.organizationId, name: user.organizationName, slug: user.organizationName.toLowerCase(), tier: user.tier, quotas, periodDays: 3 };
}

export const PREFERENCES = {
  favorites: [] as string[],
  recents: [] as string[],
  notifications: { muteQuotaWarnings: false, ecosystem: { reviewsEmail: true, upgradesEmail: true, installsEmail: true, moderationDigestEmail: true } },
};

export const ok = (data?: unknown): StubReply => ({ json: data === undefined ? { success: true } : { success: true, data } });

/** The reads every signed-in page makes; a spec overrides what it asserts on. */
function signedInDefaults(user: StubUser): Record<string, Handler> {
  return {
    'GET /api/user/profile': () => ok({ user }),
    'GET /api/user/organizations': () => ok({ organizations: user.organizations }),
    'GET /api/config': () => ok(CONFIG),
    'GET /api/billing/config': () => ok({ enabled: true, provider: 'stripe' }),
    'GET /api/pipelines': () => ok({ pipelines: [], pagination: { total: 0, limit: 25, offset: 0, hasMore: false } }),
    'GET /api/plugins': () => ok({ plugins: [], pagination: { total: 0, hasMore: false } }),
    'GET /api/messages/unread/count': () => ok({ count: 0 }),
    'GET /api/quota': () => ok({ quota: quotaFor(user) }),
    'GET /api/user/preferences': () => ok({ preferences: PREFERENCES }),
  };
}

export interface Backend {
  /** Answer `METHOD /path` (exact path, query ignored) with `handler`. */
  on(key: string, handler: Handler | StubReply): void;
  /** Every recorded request for `METHOD /path`. */
  calls(key: string): RecordedCall[];
  /** `METHOD /path` keys that fell through to the default. */
  unhandled: Set<string>;
  /** Uncaught exceptions the page threw (a spec asserts this stays empty). */
  pageErrors: string[];
  /** Make the stubbed session signed in as `user` (profile + token refresh). */
  signIn(user?: StubUser): void;
}

export async function stubBackend(page: Page): Promise<Backend> {
  const handlers = new Map<string, Handler>();
  const recorded = new Map<string, RecordedCall[]>();
  const unhandled = new Set<string>();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const backend: Backend = {
    on(key, handler) {
      handlers.set(key, typeof handler === 'function' ? handler : () => handler);
    },
    calls(key) { return recorded.get(key) ?? []; },
    unhandled,
    pageErrors,
    signIn(user = OWNER) {
      for (const [k, h] of Object.entries(signedInDefaults(user))) if (!handlers.has(k)) handlers.set(k, h);
      // Replaces the signed-out refusal; a spec that wants its own refresh
      // behaviour registers it AFTER signing in.
      handlers.set('POST /api/auth/refresh', () => ok({ accessToken: fakeJwt(), expiresIn: 3600 }));
    },
  };

  // Signed out by default: the session probe and profile both refuse.
  handlers.set('POST /api/auth/refresh', () => ({ status: 401, json: { success: false, message: 'No session' } }));
  handlers.set('GET /api/config', () => ok(CONFIG));
  handlers.set('GET /api/billing/config', () => ok({ enabled: true, provider: 'stripe' }));
  handlers.set('GET /api/auth/oauth/providers', () => ok({ providers: [] }));
  // The sign-in card's passkey autofill: the options read answers as the
  // platform does, and the browser reports no conditional mediation (headless
  // Chromium has no platform authenticator, and would otherwise fail the
  // autofill with an error that hides the card's own banners). The explicit
  // "Sign in with a passkey" still works against a virtual authenticator.
  handlers.set('POST /api/auth/webauthn/login/options', () => ok({
    ceremonyId: 'cer-login',
    options: { challenge: randomBytes(32).toString('base64url'), rpId: 'localhost', timeout: 300_000, userVerification: 'preferred', allowCredentials: [] },
  }));
  await page.addInitScript(() => {
    try {
      Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { value: async () => false, configurable: true });
    } catch { /* no WebAuthn at all — nothing to quieten */ }
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Next's own API routes (the client-error relay) are not the backend.
    if (url.pathname.startsWith('/api/client-errors')) return route.fulfill({ status: 204, body: '' });
    const key = `${req.method()} ${url.pathname}`;
    let json: unknown;
    try { json = req.postDataJSON(); } catch { json = req.postData(); }
    const call: RecordedCall = { method: req.method(), path: url.pathname, query: url.searchParams, headers: await req.allHeaders(), json };
    recorded.set(key, [...(recorded.get(key) ?? []), call]);
    const handler = handlers.get(key);
    if (!handler) unhandled.add(key);
    const reply = handler ? await handler(call, req) : ok();
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json',
      headers: reply.headers,
      body: JSON.stringify(reply.json ?? {}),
    });
  });
  return backend;
}

/**
 * Start a page already signed in, the way a returning browser is: the session
 * marker is set, so the app trades the (stubbed) refresh cookie for a token on
 * boot and loads the profile.
 */
export async function signedInPage(page: Page, user: StubUser = OWNER): Promise<Backend> {
  const api = await stubBackend(page);
  api.signIn(user);
  await page.addInitScript(() => {
    try { localStorage.setItem('pb.session', '1'); } catch { /* storage blocked */ }
  });
  return api;
}
