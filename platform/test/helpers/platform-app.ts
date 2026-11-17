// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The REAL platform route table behind a real HTTP listener, for integration
 * suites that need to drive a flow end to end (impersonation, step-up) rather
 * than call a controller with a hand-built `req`.
 *
 * What is real: `mountApiRoutes` (the exact table `index.ts` serves — every
 * route's `requireAuth`, `requireAssurance`, `requireStepUp`, permission gates
 * and controller), body parsing, the pre-auth read-only impersonation fence
 * (rebuilt from the SAME two exports `index.ts` composes it from), and the
 * not-found / error handlers. What is NOT: helmet/cors/metrics/readiness, which
 * decide nothing these suites assert, and the per-surface limiters, replaced by
 * passthroughs (the `/auth` buckets are attached per route and fall back to
 * their in-memory store without Redis).
 *
 * Downstream services (message, quota) are answered by a local stub HTTP server
 * the suite points `MESSAGE_SERVICE_*` / `QUOTA_SERVICE_*` at BEFORE importing
 * this module — see `stub-services.ts` (kept separate because THIS module
 * imports the config, which reads that env once). Import this module DYNAMICALLY,
 * after the env is set and mongoose is connected: it pulls in the config.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';

import { notFoundHandler, errorHandler } from '../../src/middleware/index.js';
import { peekJwtClaims } from '../../src/middleware/rate-limit-keys.js';
import { denyReadOnlyImpersonationWrite, isWriteBlockedByImpersonation } from '../../src/middleware/require-write-access.js';
import { User } from '../../src/models/index.js';
import { mountApiRoutes } from '../../src/routes/mount.js';
import { createAccessTokenPayload, type SessionAuth } from '../../src/services/session/access-tokens.js';
import { resolveOrgMembership } from '../../src/services/session/membership-context.js';
import { signUserJwt } from '../../src/services/token-signing/index.js';

export interface RunningApp {
  base: string;
  close: () => Promise<void>;
}

export async function listen(app: express.Express | http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(app as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export const closer = (server: http.Server) => () => new Promise<void>((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

/**
 * Boot the platform route table on an ephemeral port. `preAuthFence: false`
 * leaves out the pre-auth read-only fence, so a suite can prove the
 * post-verification backstop in `requireAuth` holds ON ITS OWN.
 */
export async function startPlatformApp(opts: { preAuthFence?: boolean } = {}): Promise<RunningApp> {
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json({ limit: '1mb' }));
  // The pre-auth read-only fence, composed exactly as index.ts composes it.
  if (opts.preAuthFence !== false) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isWriteBlockedByImpersonation(req.method, peekJwtClaims(req).impersonationReadOnly === true)) {
        denyReadOnlyImpersonationWrite(req, res);
        return;
      }
      next();
    });
  }
  const passthrough = (_req: Request, _res: Response, next: NextFunction): void => next();
  mountApiRoutes(app, { alertWebhook: passthrough, observability: passthrough, scim: passthrough });
  app.use(notFoundHandler);
  app.use(errorHandler);
  const { server, base } = await listen(app);
  return { base, close: closer(server) };
}

/** A strong (passkey-grade) sign-in, minted NOW. */
export const strongAuth = (): SessionAuth => ({ amr: ['webauthn'], aal: 2, authTime: new Date() });
/** A password-only sign-in. */
export const weakAuth = (): SessionAuth => ({ amr: ['pwd'], aal: 1, authTime: new Date() });

/**
 * Mint a session ACCESS token for `userId` scoped to `orgId`, with the real
 * payload builder and the real signer — the same claims a sign-in would carry,
 * WITHOUT a refresh-session slot (`sid`), so these suites never depend on how
 * refresh sessions are stored.
 */
export async function mintAccessToken(userId: string, orgId: string | undefined, auth: SessionAuth = strongAuth()): Promise<string> {
  const user = await User.findById(userId).select('+tokenVersion +isSuperAdmin');
  if (!user) throw new Error(`mintAccessToken: no user ${userId}`);
  const membership = orgId ? await resolveOrgMembership(userId, orgId) : undefined;
  const payload = createAccessTokenPayload(user, membership, { auth, tokenUse: 'access' });
  return signUserJwt(payload, { expiresIn: 900 });
}

/** A small fetch wrapper: JSON in, `{ status, body }` out. */
export function client(base: string) {
  return async function call(
    method: string,
    path: string,
    opts: { token?: string; authorization?: string; stepUp?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: { success?: boolean; data?: Record<string, unknown>; code?: string; message?: string } & Record<string, unknown> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.authorization !== undefined) headers.authorization = opts.authorization;
    else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.stepUp) headers['x-step-up-token'] = opts.stepUp;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: res.status, body };
  };
}
