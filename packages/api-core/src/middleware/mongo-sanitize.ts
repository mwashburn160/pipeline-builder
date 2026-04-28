// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, Response } from 'express';

/**
 * MongoDB operator-injection middleware.
 *
 * Recursively strips object keys starting with `$` (Mongo operators like
 * `$ne`, `$gt`, `$where`) and keys containing `.` (dot-walks) from
 * `req.body`, `req.query`, and `req.params`. Without this, a JSON request
 * like `{"email": {"$ne": null}}` against a Mongo-backed service can match
 * any document — Zod catches the wrong *type* but won't reach into nested
 * objects to strip operator-shaped keys.
 *
 * Apply BEFORE any Mongo query handler (typically right after
 * `express.json()`). Postgres-backed services don't need it.
 *
 * Modifies in place. On Express 5+ where `req.query` is a read-only getter,
 * this still works because we mutate the underlying object's keys, not the
 * reference.
 */
export function mongoSanitize() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object') sanitizeObject(req.body);
    if (req.query && typeof req.query === 'object') sanitizeObject(req.query as Record<string, unknown>);
    if (req.params && typeof req.params === 'object') sanitizeObject(req.params as unknown as Record<string, unknown>);
    next();
  };
}

function sanitizeObject(obj: Record<string, unknown>, depth = 0): void {
  // Cap depth — defense against pathological nested input.
  if (depth > 10) return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
      continue;
    }
    const v = obj[key];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object') sanitizeObject(item as Record<string, unknown>, depth + 1);
        }
      } else {
        sanitizeObject(v as Record<string, unknown>, depth + 1);
      }
    }
  }
}
