// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * UUID path-parameter guard for the compliance routes.
 *
 * Every compliance id column is a Postgres `uuid`, so a malformed id handed to a
 * query is a cast error — an unhandled 500 for what is the caller's mistake. A
 * route reads its id through {@link uuidParam}, which answers 400
 * VALIDATION_ERROR before any query runs (the same answer the audit route gives
 * a malformed `scanId` filter).
 */

import { ErrorCode, getParam, sendBadRequest } from '@pipeline-builder/api-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

const Uuid = z.string().uuid();

/** True when `value` is a well-formed UUID string. */
export function isUuid(value: unknown): value is string {
  return Uuid.safeParse(value).success;
}

/**
 * The `key` path parameter when it is a UUID. Otherwise sends 400
 * VALIDATION_ERROR naming it and returns undefined — the caller just returns.
 */
export function uuidParam(req: Request, res: Response, key: string): string | undefined {
  const value = getParam(req.params, key);
  if (isUuid(value)) return value;
  sendBadRequest(res, `${key} must be a UUID`, ErrorCode.VALIDATION_ERROR);
  return undefined;
}
