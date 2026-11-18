// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The CLIENT half of an internal endpoint contract: one typed call over the
 * shared {@link InternalHttpClient} (or a `createSafeClient` wrapper).
 *
 * `callInternal` builds the path from the contract, validates the body it is
 * about to send (sending a body the contract rejects is a programming error, so
 * it throws {@link ContractRequestError} rather than earning a 400 at runtime),
 * and parses a 2xx reply's `data` with the contract's response schema.
 *
 * It does NOT decide what a failure means — that is each caller's policy (fail
 * open, fail closed, retry with the same idempotency key, treat a timeout as an
 * unknown outcome). So it never throws for a non-2xx or an unreadable reply; it
 * returns an {@link InternalCallResult} naming which of those happened. A
 * transport failure (timeout, abort, open breaker, {@link InvalidResponseBodyError})
 * propagates from the underlying client exactly as it does today, and a
 * `createSafeClient` that swallowed one yields `reason: 'unreachable'`.
 */

import type { IncomingHttpHeaders } from 'node:http';
import type { z } from 'zod';
import {
  buildContractPath,
  type ContractResponse,
  type InternalEndpointContract,
  type QueryValue,
} from './define.js';
import type { DeleteRequestOptions, HttpClientResponse, RequestOptions } from '../services/http-client.js';
import { validate } from '../validation/middleware.js';

/**
 * What `callInternal` needs from a client: the four verbs of
 * `InternalHttpClient`, or of `createSafeClient` (which resolves `null` instead
 * of throwing).
 */
export interface ContractHttpClient {
  get<T>(path: string, options?: RequestOptions): Promise<HttpClientResponse<T> | null>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<HttpClientResponse<T> | null>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<HttpClientResponse<T> | null>;
  delete<T>(path: string, options?: DeleteRequestOptions): Promise<HttpClientResponse<T> | null>;
}

/** What one `callInternal` needs: path params, query, body, and request options. */
export interface InternalCallInput<C extends InternalEndpointContract> {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  /** The JSON body, validated against the contract's `body` schema before sending. */
  body?: z.input<NonNullable<C['body']>>;
  /** Passed through to the client (headers, timeout, retries, signal, …). */
  options?: RequestOptions;
}

/** The outcome of one internal call. Only `ok: true` carries parsed data. */
export type InternalCallResult<R> =
  /** 2xx, and the reply's `data` matched the response schema. */
  | { ok: true; status: number; headers: IncomingHttpHeaders; data: R; body: unknown }
  /** A safe client swallowed a transport failure (nothing is known about the outcome). */
  | { ok: false; reason: 'unreachable' }
  /** A non-2xx status. `body` is the parsed error envelope (`{}` when unreadable). */
  | { ok: false; reason: 'status'; status: number; headers: IncomingHttpHeaders; body: unknown }
  /** A 2xx whose `data` did not match the response schema. */
  | { ok: false; reason: 'invalid-response'; status: number; headers: IncomingHttpHeaders; body: unknown; error: string };

/** The caller tried to send a body (or params) its own contract rejects. */
export class ContractRequestError extends Error {
  readonly code = 'CONTRACT_REQUEST_INVALID';
  constructor(readonly contractId: string, detail: string) {
    super(`Invalid request for internal endpoint ${contractId}: ${detail}`);
    this.name = 'ContractRequestError';
  }
}

/** The success envelope's `data`, or `undefined` when the body has no `data` key. */
function envelopeData(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data?: unknown }).data;
  return undefined;
}

/**
 * Parse a reply's `data` with the contract's response schema. Exported for
 * callers that already hold a response (and for the contract tests).
 */
export function parseContractResponse<C extends InternalEndpointContract>(
  contract: C, body: unknown,
): { ok: true; value: ContractResponse<C> } | { ok: false; error: string } {
  const result = validate(envelopeData(body), contract.response);
  return result.ok ? { ok: true, value: result.value as ContractResponse<C> } : { ok: false, error: result.error };
}

/**
 * Call an internal endpoint through its contract. See the module comment for
 * what throws and what is returned.
 */
export async function callInternal<C extends InternalEndpointContract>(
  client: ContractHttpClient,
  contract: C,
  input: InternalCallInput<C> = {},
): Promise<InternalCallResult<ContractResponse<C>>> {
  let path: string;
  try {
    path = buildContractPath(contract, input.params, input.query);
  } catch (err) {
    throw new ContractRequestError(contract.id, (err as Error).message);
  }

  let body: unknown;
  if (contract.body) {
    const parsed = validate(input.body ?? {}, contract.body);
    if (!parsed.ok) throw new ContractRequestError(contract.id, parsed.error);
    body = parsed.value;
  }

  let response: HttpClientResponse<unknown> | null;
  switch (contract.method) {
    case 'GET': response = await client.get<unknown>(path, input.options); break;
    case 'POST': response = await client.post<unknown>(path, body, input.options); break;
    case 'PUT': response = await client.put<unknown>(path, body, input.options); break;
    case 'DELETE': response = await client.delete<unknown>(path, input.options as DeleteRequestOptions); break;
  }

  if (!response) return { ok: false, reason: 'unreachable' };
  const { statusCode: status, headers } = response;
  if (status < 200 || status >= 300) return { ok: false, reason: 'status', status, headers, body: response.body };
  const parsed = parseContractResponse(contract, response.body);
  if (!parsed.ok) return { ok: false, reason: 'invalid-response', status, headers, body: response.body, error: parsed.error };
  return { ok: true, status, headers, data: parsed.value, body: response.body };
}
