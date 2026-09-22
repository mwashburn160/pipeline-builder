// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator/prototype-key sanitizer for SCIM request bodies.
 *
 * The app-wide `mongoSanitize()` runs BEFORE the SCIM router parses its body
 * (`application/scim+json` is parsed router-locally — see routes/scim.ts), so
 * without this a SCIM body would reach the handlers unsanitized.
 *
 * It is not `mongoSanitize()` itself because that also strips DOTTED keys, and
 * dotted keys are legitimate SCIM: the path-less PATCH form every major IdP
 * sends (`{ "op": "replace", "value": { "name.givenName": "Ada" } }`) names the
 * attribute BY its dotted path. Those keys are never Mongo keys — the SCIM
 * service maps each attribute explicitly — so what must go is exactly what could
 * become a query operator or walk a prototype: `$`-prefixed keys and
 * `__proto__` / `constructor` / `prototype`. Over-deep bodies are refused.
 */

import type { Request, Response, NextFunction } from 'express';
import { sendScimError } from '../utils/scim-response.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Deeper than any real SCIM resource or PatchOp. */
const MAX_DEPTH = 32;

class ScimBodyTooDeep extends Error {}

function strip(value: unknown, depth: number): void {
  if (!value || typeof value !== 'object') return;
  if (depth > MAX_DEPTH) throw new ScimBodyTooDeep();
  if (Array.isArray(value)) {
    for (const item of value) strip(item, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) {
      delete obj[key];
      continue;
    }
    strip(obj[key], depth + 1);
  }
}

export function scimSanitize(req: Request, res: Response, next: NextFunction): void {
  try {
    strip(req.body, 0);
  } catch (err) {
    if (err instanceof ScimBodyTooDeep) {
      sendScimError(res, 400, 'The request body is nested too deeply.', { scimType: 'invalidSyntax' });
      return;
    }
    throw err;
  }
  next();
}
