// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared driver for the PGlite controller suites: a minimal Express `res`
 * double the REAL api-core `sendSuccess` / `sendError` write into, and a
 * `call` that runs a controller inside the caller's tenant context (the same
 * AsyncLocalStorage scope `tenantScope` establishes in production), so the
 * service's `withTenantTx` runs under that org's RLS policies.
 */

import { asTenantContext } from '@pipeline-builder/pipeline-data/testing';

export interface TestRes {
  statusCode?: number;
  body?: { success?: boolean; data?: any; message?: string; code?: string };
  headers: Record<string, unknown>;
  headersSent: boolean;
  sent?: unknown;
  status(n: number): TestRes;
  json(b: unknown): TestRes;
  send(b: unknown): TestRes;
  setHeader(k: string, v: unknown): void;
}

export function makeRes(): TestRes {
  const res: TestRes = {
    headers: {},
    headersSent: false,
    status(n) { res.statusCode = n; return res; },
    json(b) { res.body = b as TestRes['body']; res.headersSent = true; return res; },
    send(b) { res.sent = b; res.headersSent = true; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
  };
  return res;
}

export interface Caller {
  orgId: string;
  userId: string;
  role?: string;
  email?: string;
  isSuperAdmin?: boolean;
}

export type Controller = (req: any, res: any) => Promise<void>;

/** Run `handler` as `caller` (tenant context + `req.user`), returning the response. */
export async function call(
  handler: Controller,
  caller: Caller,
  req: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): Promise<TestRes> {
  const res = makeRes();
  const fullReq = {
    method: 'POST',
    headers: {},
    params: req.params ?? {},
    body: req.body,
    query: req.query ?? {},
    user: {
      sub: caller.userId,
      organizationId: caller.orgId,
      role: caller.role ?? 'admin',
      ...(caller.email ? { email: caller.email } : {}),
      ...(caller.isSuperAdmin ? { isSuperAdmin: true } : {}),
    },
  };
  await asTenantContext({ orgId: caller.orgId, userId: caller.userId, isSuperAdmin: !!caller.isSuperAdmin }, () => handler(fullReq, res));
  return res;
}
