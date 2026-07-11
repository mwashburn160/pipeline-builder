// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextFunction, Request, Response } from 'express';
import { HttpStatus } from '../constants/http-status.js';
import { ErrorCode } from '../types/error-codes.js';
import { sendError } from '../utils/response.js';

/** Maximum nesting depth accepted by {@link mongoSanitize}. */
export const MAX_SANITIZE_DEPTH = 10;

/**
 * Thrown when a request payload nests deeper than {@link MAX_SANITIZE_DEPTH}.
 * The middleware maps this to HTTP 400 instead of silently truncating the walk
 * (which would let operator-shaped keys below the cap slip through unsanitized).
 */
export class PayloadTooDeepError extends Error {
  readonly statusCode = HttpStatus.BAD_REQUEST;
  constructor(message = `Request payload nesting exceeds the maximum depth of ${MAX_SANITIZE_DEPTH}`) {
    super(message);
    this.name = 'PayloadTooDeepError';
  }
}

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
 * `req.body` and `req.params` are plain writable objects, so they're sanitized
 * in place. On Express 5 `req.query` is a GETTER that re-parses the URL and
 * returns a fresh object on every access — mutating it is a no-op — so we
 * sanitize a snapshot and pin it onto the request instance with
 * `Object.defineProperty`, shadowing the getter for all downstream reads.
 */
export function mongoSanitize() {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.body && typeof req.body === 'object') sanitizeObject(req.body);
      if (req.params && typeof req.params === 'object') sanitizeObject(req.params as Record<string, unknown>);
      if (req.query && typeof req.query === 'object') {
        const q = req.query as Record<string, unknown>;
        sanitizeObject(q);
        // Pin the sanitized snapshot so the Express 5 getter can't re-parse a
        // fresh (unsanitized) object on the next access.
        try {
          Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });
        } catch {
          // Express 4 (writable data prop) — the in-place sanitize above sufficed.
        }
      }
    } catch (err) {
      // Reject over-deep payloads with a 400 rather than silently truncating
      // the sanitize walk (which risked leaving deep operator keys in place).
      if (err instanceof PayloadTooDeepError) {
        return sendError(res, err.statusCode, err.message, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
    next();
  };
}

// Prototype-pollution keys — these never belong in JSON request bodies, and a
// downstream recursive merge/assign on the parsed object could otherwise walk
// `constructor.prototype` to inject Mongo operators or pollute Object.prototype.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeObject(obj: Record<string, unknown>, depth = 0): void {
  // Reject pathologically nested input rather than silently returning — a
  // silent cap would leave any operator/dot/prototype keys deeper than the
  // cap un-sanitized. The middleware maps this to a 400.
  if (depth > MAX_SANITIZE_DEPTH) {
    throw new PayloadTooDeepError();
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key)) {
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
