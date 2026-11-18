// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * INTERNAL ENDPOINT CONTRACTS — one definition per service-to-service route.
 *
 * Before this module an internal call was two string literals that had to agree:
 * the route the SERVER registered (`router.post('/internal/…/:orgId/consume')`)
 * and the path the CLIENT built (`` `/internal/…/${orgId}/consume` ``), each with
 * its own idea of the body — the server hand-parsing it, the client assembling it
 * — and nothing but a code review keeping the two in step.
 *
 * A contract states the endpoint ONCE:
 *
 *  - `service` + `method` + `path` — where it is served, exactly as the serving
 *    app's route table records it (`buildRouteTable`), mount prefix included;
 *  - `callers` — the services `requireInternalService` admits (the same list the
 *    service's route-coverage declaration and the Istio policy name);
 *  - `params` / `query` / `body` — zod schemas for what the caller sends;
 *  - `response` — a zod schema for the success envelope's `data`.
 *
 * The SERVER mounts at {@link contractRoute} and validates with
 * {@link parseContractBody} / {@link parseContractParams} /
 * {@link parseContractQuery} (its own error mapping and status codes stay its
 * own). The CLIENT calls through `callInternal` (`./call.ts`), which builds the
 * path with {@link buildContractPath} and parses the reply with `response`.
 * Each serving service has a contract test that checks the route is mounted at
 * the contract's method + path with the contract's callers, and that a sample
 * request and response round-trip through the schemas.
 */

import type { Request } from 'express';
import type { z } from 'zod';
import { validate, type ValidationResult } from '../validation/middleware.js';

/** The HTTP methods an internal endpoint may use. */
export type InternalMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A zod schema with no particular output type. */
type AnySchema = z.ZodType;

/** One internal endpoint, defined once and used by both its server and its clients. */
export interface InternalEndpointContract<
  P extends AnySchema = AnySchema,
  Q extends AnySchema = AnySchema,
  B extends AnySchema = AnySchema,
  R extends AnySchema = AnySchema,
> {
  /** Stable id, `<service>.<name>` — names the contract in test output and logs. */
  readonly id: string;
  /** The service that SERVES the route (matches its `serviceEndpoint` name). */
  readonly service: string;
  readonly method: InternalMethod;
  /**
   * The full route path as the serving app's route table records it — mount
   * prefix included (`/billing/internal/…`), Express `:param` placeholders. The
   * client sends exactly this path, with the params substituted.
   *
   * Always under the `/internal` convention ({@link isInternalConventionPath}):
   * `/internal/…` or `/<service-prefix>/internal/…`. The gateway refuses that
   * segment from outside, so every internal contract is off the external
   * surface by one rule rather than by a per-route list.
   */
  readonly path: string;
  /** The services `requireInternalService({ callers })` admits on the route. */
  readonly callers: readonly string[];
  /**
   * What the route requires beyond the caller list, in prose: the token's org
   * binding, role, any extra handler-level check. Documentation for reviewers;
   * the gates themselves are the existing middleware.
   */
  readonly auth: string;
  /** Path params (`:name` placeholders). `z.object({})` for none. */
  readonly params: P;
  /** Query string. Absent when the route reads none. */
  readonly query?: Q;
  /** JSON body. Absent for a GET/DELETE, or a POST that sends none. */
  readonly body?: B;
  /** The success envelope's `data` (what `sendSuccess(res, status, data)` sends). */
  readonly response: R;
}

/** The parsed (output) type of a contract's params. */
export type ContractParams<C extends InternalEndpointContract> = z.output<C['params']>;
/** The parsed (output) type of a contract's query. */
export type ContractQuery<C extends InternalEndpointContract> = [NonNullable<C['query']>] extends [never] ? Record<string, never> : z.output<NonNullable<C['query']>>;
/** The parsed (output) type of a contract's body. */
export type ContractBody<C extends InternalEndpointContract> = [NonNullable<C['body']>] extends [never] ? undefined : z.output<NonNullable<C['body']>>;
/** The parsed (output) type of a contract's success `data`. */
export type ContractResponse<C extends InternalEndpointContract> = z.output<C['response']>;

/** The `:name` placeholders in an Express path, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

/**
 * Whether a path follows the `/internal` convention: an `internal` FIRST or
 * SECOND segment (`/internal/…`, `/billing/internal/…`). The second-segment
 * form is a service's own mount prefix followed by `internal`; that is exactly
 * what the gateway's refusal (`^/api/(?:[^/]+/)?internal(?:/|$)`) matches once
 * it is put behind the `/api` prefix. Matched case-insensitively, as Express
 * routes are.
 */
export function isInternalConventionPath(path: string): boolean {
  return /^\/(?:[^/]+\/)?internal(?:\/|$)/i.test(path);
}

/**
 * Define an internal endpoint. Checks at module load that the path is absolute,
 * that every caller is named, and that the path follows the `/internal`
 * convention ({@link isInternalConventionPath}) — a contract that is wrong
 * fails every import, not one request in production.
 */
export function defineInternalEndpoint<
  P extends AnySchema,
  Q extends AnySchema = never,
  B extends AnySchema = never,
  R extends AnySchema = AnySchema,
>(contract: InternalEndpointContract<P, Q, B, R>): InternalEndpointContract<P, Q, B, R> {
  if (!contract.path.startsWith('/')) throw new Error(`Contract ${contract.id}: path must start with '/'`);
  if (contract.callers.length === 0) throw new Error(`Contract ${contract.id}: an internal endpoint names its callers`);
  // `callInternal` sends no body for a GET or DELETE (the client verbs take
  // none), so a body schema there would be validated and then silently dropped.
  if (contract.body && (contract.method === 'GET' || contract.method === 'DELETE')) {
    throw new Error(`Contract ${contract.id}: a ${contract.method} endpoint cannot declare a body`);
  }
  if (!isInternalConventionPath(contract.path)) {
    throw new Error(`Contract ${contract.id}: ${contract.path} is outside the /internal convention (/internal/… or /<service>/internal/…)`);
  }
  return Object.freeze({ ...contract, callers: Object.freeze([...contract.callers]) });
}

/**
 * The route path to register on a router mounted at `mount`: the contract's
 * path with the mount prefix removed (`'/'` when nothing is left). Throws when
 * the contract is not under that mount — the server would otherwise serve the
 * route somewhere its clients never call.
 */
export function contractRoute(contract: InternalEndpointContract, mount = ''): string {
  const prefix = mount.replace(/\/+$/, '');
  if (prefix && contract.path !== prefix && !contract.path.startsWith(`${prefix}/`)) {
    throw new Error(`Contract ${contract.id} (${contract.path}) is not under the mount '${mount}'`);
  }
  const rest = contract.path.slice(prefix.length);
  return rest === '' ? '/' : rest;
}

/** A query value the path builder can serialize. `undefined` is omitted. */
export type QueryValue = string | number | boolean | undefined;

/**
 * The concrete path for one call: each `:name` replaced by its URI-encoded
 * param, then the query string (entries with an `undefined` value omitted).
 * Throws when a placeholder has no value — a call to `/x/undefined/y` would
 * reach some OTHER resource.
 */
export function buildContractPath(
  contract: InternalEndpointContract,
  params: Record<string, string | number> = {},
  query?: Record<string, QueryValue>,
): string {
  const path = contract.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || String(value) === '') {
      throw new Error(`Contract ${contract.id}: missing path param '${name}'`);
    }
    return encodeURIComponent(String(value));
  });
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Validate a request BODY against the contract. An absent body is read as `{}`
 * (a POST with no JSON is the same request as one with an empty object). A
 * contract with no body schema accepts anything and yields `undefined`.
 */
export function parseContractBody<C extends InternalEndpointContract>(
  contract: C, req: Pick<Request, 'body'>,
): ValidationResult<ContractBody<C>> {
  if (!contract.body) return { ok: true, value: undefined as ContractBody<C> };
  return validate(req.body ?? {}, contract.body) as ValidationResult<ContractBody<C>>;
}

/** Validate the request's PATH params against the contract. */
export function parseContractParams<C extends InternalEndpointContract>(
  contract: C, req: Pick<Request, 'params'>,
): ValidationResult<ContractParams<C>> {
  return validate(req.params ?? {}, contract.params) as ValidationResult<ContractParams<C>>;
}

/** Validate the request's QUERY against the contract (`{}` when it reads none). */
export function parseContractQuery<C extends InternalEndpointContract>(
  contract: C, req: Pick<Request, 'query'>,
): ValidationResult<ContractQuery<C>> {
  if (!contract.query) return { ok: true, value: {} as ContractQuery<C> };
  return validate(req.query ?? {}, contract.query) as ValidationResult<ContractQuery<C>>;
}

/** The first zod issue's own message (no `path:` prefix), else the summary. */
export function contractErrorMessage(result: { error: string; zodError?: z.ZodError }): string {
  return result.zodError?.issues[0]?.message ?? result.error;
}
