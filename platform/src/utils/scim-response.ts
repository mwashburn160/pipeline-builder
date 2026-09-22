// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SCIM wire responses.
 *
 * The rest of the platform answers in its own `{ success, data, message }`
 * envelope (api-core's `sendSuccess`/`sendError`). SCIM cannot: RFC 7644 fixes
 * both the media type (`application/scim+json`) and the error document
 * (`urn:ietf:params:scim:api:messages:2.0:Error` with `status` as a STRING and an
 * optional `scimType`), and identity providers parse exactly that. So these two
 * helpers exist alongside — not instead of — the platform's, and every SCIM
 * handler goes through them.
 */

import type { Response } from 'express';
import { SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA } from '../constants/scim.js';
import type { ScimType } from '../services/scim-errors.js';

/** Send a SCIM resource (or list) with the SCIM media type. */
export function sendScim(res: Response, status: number, body: unknown, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).type(`${SCIM_CONTENT_TYPE}; charset=utf-8`).send(JSON.stringify(body));
}

/**
 * Send an RFC 7644 §3.12 error document. `reason` is accepted (and ignored here)
 * so call sites can pass the metric label along with the message from one object
 * — it is never serialized: an internal label is not the client's business.
 */
export function sendScimError(
  res: Response,
  status: number,
  detail: string,
  opts: { scimType?: ScimType; reason?: string } = {},
): void {
  sendScim(res, status, {
    schemas: [SCIM_ERROR_SCHEMA],
    ...(opts.scimType ? { scimType: opts.scimType } : {}),
    detail,
    // A STRING, per the RFC — several IdPs reject a numeric `status` outright.
    status: String(status),
  });
}
