// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared harness for the per-router handler suites (read/create/update/delete).
 *
 * Handlers are pulled off the router and invoked directly with mock req/res —
 * no HTTP server. The route chains (`createAuthenticatedWithOrgRoute` /
 * `createProtectedRoute`) resolve to `[]` and guards are skipped by grabbing the
 * LAST layer, so these suites exercise business logic only; the real auth /
 * step-up / idempotency wiring is covered by index-wiring.test.ts and the
 * permission gates by route-permissions.test.ts.
 */

import { jest } from '@jest/globals';

/** api-core overrides the handler suites share (response helpers with real
 *  status/body shapes, validation pass-throughs, alias resolution). */
export function routeApiCoreOverrides(): Record<string, unknown> {
  return {
    getParam: jest.fn((params: Record<string, string>, key: string) => params[key]),
    isSystemAdmin: jest.fn(() => false),
    isServicePrincipal: jest.fn(() => false),
    sendSuccess: jest.fn((res: any, statusCode: number, data?: any, message?: string) => {
      const response: any = { success: true, statusCode };
      if (data !== undefined) response.data = data;
      if (message) response.message = message;
      res.status(statusCode).json(response);
    }),
    sendPaginatedNested: jest.fn((res: any, dataKey: string, data: any, opts: any) => {
      const pagination: any = { limit: opts.limit, offset: opts.offset, hasMore: opts.hasMore };
      if (opts.total !== undefined) pagination.total = opts.total;
      if (opts.nextCursor) pagination.nextCursor = opts.nextCursor;
      res.status(opts.statusCode ?? 200).json({ [dataKey]: data, pagination });
    }),
    sendError: jest.fn((res: any, statusCode: number, msg: string, code?: string) => {
      res.status(statusCode).json({ success: false, statusCode, message: msg, code });
    }),
    sendBadRequest: jest.fn((res: any, msg: string, code?: string) => {
      res.status(400).json({ success: false, statusCode: 400, message: msg, code });
    }),
    sendInternalError: jest.fn((res: any, msg: string) => {
      res.status(500).json({ success: false, statusCode: 500, message: msg });
    }),
    parsePaginationParams: jest.fn(() => ({
      limit: 25,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    })),
    validateBody: jest.fn((req: any) => {
      if (!req.body || Object.keys(req.body).length === 0) {
        return { ok: false, error: 'Request body is required' };
      }
      return { ok: true, value: req.body };
    }),
    MessageCreateSchema: {},
    MessageReplySchema: {},
    MessageEditSchema: {},
    MessageFilterSchema: {},
    validateQuery: jest.fn(() => ({ ok: true, value: {} })),
    incrementQuota: jest.fn(),
    sendEntityNotFound: jest.fn((res: any, entity: string) => {
      res.status(404).json({ success: false, statusCode: 404, message: `${entity} not found.` });
    }),
    resolveRecipientAlias: jest.fn((recipientOrgId: string) => {
      const aliases = new Set(['support@pipeline-builder', 'help@pipeline-builder']);
      const normalized = recipientOrgId.trim().toLowerCase();
      if (aliases.has(normalized)) {
        return { resolvedOrgId: '000000000000000000000001', wasAlias: true, originalValue: recipientOrgId };
      }
      return { resolvedOrgId: normalized, wasAlias: false, originalValue: recipientOrgId };
    }),
  };
}

/** api-server namespace: a withRoute that mirrors the real org/user extraction
 *  and 500-on-throw, plus empty route chains. */
export function routeApiServerMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sendBadRequestForRoute = (res: any, msg: string) => {
    res.status(400).json({ success: false, statusCode: 400, message: msg });
  };
  const sendInternalErrorForRoute = (res: any, msg: string) => {
    res.status(500).json({ success: false, statusCode: 500, message: msg });
  };
  return {
    incCounter: () => undefined,
    rateLimitByOrg: () => (_req: any, _res: any, next: () => void) => next(),
    getContext: (req: any) => req.context,
    withRoute: (handler: Function, options?: any) => async (req: any, res: any) => {
      const ctx = req.context;
      const orgId = ctx.identity.orgId?.toLowerCase() || '';
      const userId = ctx.identity.userId || '';
      const requireOrgId = options?.requireOrgId !== false;
      if (requireOrgId && !orgId) {
        return sendBadRequestForRoute(res, 'Organization ID is required');
      }
      try {
        await handler({ req, res, ctx, orgId, userId });
      } catch (error: any) {
        const msg = error instanceof Error ? error.message : String(error);
        return sendInternalErrorForRoute(res, msg);
      }
    },
    incrementQuotaFromCtx: jest.fn(),
    // Both helpers are spread into route signatures (`...createAuthenticatedWithOrgRoute()`).
    // Return [] so the route stack contains only guards + the final withRoute handler.
    createProtectedRoute: jest.fn(() => []),
    createAuthenticatedWithOrgRoute: jest.fn(() => []),
    // Last so a suite can swap in a spy (e.g. `incCounter`) to assert on a
    // side effect the default no-op silently swallows.
    ...overrides,
  };
}

/** A messageService method that fails loudly if a route uses the WRONG lookup
 *  (e.g. an unscoped `findById` where the viewer-scoped `findVisibleById` is
 *  required). The route's withRoute turns the throw into a 500, failing the test. */
export function forbiddenLookup(name: string): (...args: unknown[]) => Promise<never> {
  return jest.fn(async () => {
    throw new Error(`route must not call messageService.${name}`);
  });
}

export function createMockQuotaService(): any {
  return {
    increment: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined),
    check: jest.fn(),
    getUsage: jest.fn(),
  };
}

export function createMockSseManager(): any {
  return {
    send: jest.fn().mockReturnValue(1),
    broadcast: jest.fn().mockReturnValue(5),
    addClient: jest.fn(),
    hasClients: jest.fn(),
    getClientCount: jest.fn(),
    getStats: jest.fn(),
    closeRequest: jest.fn(),
    shutdown: jest.fn(),
    middleware: jest.fn(),
  };
}

export function getHandler(router: any, method: string, path: string) {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  // The final layer is the withRoute business handler; any preceding layers are
  // guard middleware (e.g. requirePermission). Grab the last so the test drives
  // the handler directly without an Express `next`.
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

export function mockReq(overrides: Record<string, unknown> = {}): any {
  const user = (overrides.user as { sub?: string } | undefined) ?? { sub: 'user-1' };
  const base = {
    params: {},
    query: {},
    body: {},
    headers: { authorization: 'Bearer tok' },
    user,
    context: {
      // Derived from `user.sub`, mirroring api-core's `getIdentity` (the JWT
      // `sub` IS the identity userId). A fixture that overrides `user` without
      // this got a request no real caller can produce — JWT subject `admin-9`
      // but route-context userId `user-1` — so a route reading either one could
      // pass its test and be wrong in production.
      identity: { orgId: 'ORG-1', userId: user?.sub ?? '' },
      log: jest.fn(),
      requestId: 'req-1',
    },
  };
  return {
    ...base,
    ...overrides,
    // A suite that overrides `context` usually means "tweak one field"; merge so
    // the derived identity above isn't silently dropped.
    context: { ...base.context, ...((overrides.context as Record<string, unknown> | undefined) ?? {}) },
  };
}

export function mockRes(): any {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
