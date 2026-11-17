// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorCode, validate } from '@pipeline-builder/api-core';
import { withRoute, type WithRouteOptions } from '@pipeline-builder/api-server';
import type { Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import { callerFromRequest, EcosystemError, type Caller } from '../services/ecosystem/context.js';

/**
 * `withRoute` for the ecosystem routes: hands the handler the acting
 * {@link Caller}. An `EcosystemError` answers with its code and its
 * structured `details` (the failing gates, the quota standing) through the
 * generic AppError mapping.
 */
export function ecosystemRoute(
  handler: (args: { req: Request; res: Response; caller: Caller }) => Promise<void>,
  options: WithRouteOptions = {},
): RequestHandler {
  return withRoute(async ({ req, res }) => {
    await handler({ req, res, caller: callerFromRequest(req) });
  }, options) as RequestHandler;
}

/** The request body as a plain object (never null / an array). */
export function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {};
}

/** The value at `path` inside `root` (undefined when any step is missing). */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/**
 * The request body parsed against `schema` (api-core `validate`). A missing
 * body (or a non-object one) is read as `{}`, so an empty POST is refused by
 * the fields it lacks rather than by its shape.
 *
 * A refusal is an `EcosystemError`, keeping the codes the hand-written checks
 * answered with: a required field that is absent, null or blank is
 * `MISSING_REQUIRED_FIELD` ("<field> is required"); anything else — a wrong
 * type, a bad enum value, an unknown field on a `.strict()` schema — is
 * `VALIDATION_ERROR` with the zod message.
 */
export function bodyFrom<T>(req: Request, schema: ZodType<T>): T {
  const body = bodyOf(req);
  const result = validate(body, schema);
  if (result.ok) return result.value;
  const issue = result.zodError?.issues[0];
  if (issue && issue.path.length > 0) {
    const value = valueAt(body, issue.path);
    const blank = issue.code === 'too_small' && issue.origin === 'string' && Number(issue.minimum) === 1;
    if (value === undefined || value === null || blank) {
      throw new EcosystemError(ErrorCode.MISSING_REQUIRED_FIELD, `${issue.path.join('.')} is required`);
    }
  }
  // An unknown field's issue sits at the root: say what it is without the
  // empty "<path>: " prefix `validate` would give it.
  throw new EcosystemError(ErrorCode.VALIDATION_ERROR, issue && issue.path.length === 0 ? issue.message : result.error);
}

/** A route parameter as a string. */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}
