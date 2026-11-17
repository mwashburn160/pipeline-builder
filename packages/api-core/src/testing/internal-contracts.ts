// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract-test helpers for internal endpoint contracts (`contracts/define.ts`).
 *
 * A serving service's contract test builds its REAL route table (the same way
 * its route-coverage test does) and, for each contract it serves:
 *
 *  - {@link findContractMountViolations}: the route is mounted at exactly the
 *    contract's method + path, behind `requireAuth` and
 *    `requireInternalService` with exactly the contract's callers;
 *  - {@link roundTripContractSample}: a sample request (params, query, body)
 *    and response pass the contract's schemas, survive a JSON round trip
 *    unchanged, and the built path matches the route pattern.
 */

import { buildContractPath, pathParamNames, type InternalEndpointContract, type QueryValue } from '../contracts/define.js';
import type { RouteTableEntry } from '../middleware/route-table.js';

/** Why `contract` is not served as declared by `table` (empty ⇒ it is). */
export function findContractMountViolations(
  table: readonly RouteTableEntry[],
  contract: InternalEndpointContract,
): string[] {
  const where = `${contract.id} (${contract.method} ${contract.path})`;
  const entry = table.find((e) => e.method === contract.method && e.path === contract.path);
  if (!entry) {
    const samePath = table.filter((e) => e.path === contract.path).map((e) => e.method);
    return [`${where}: no route mounted at the contract's method + path${samePath.length ? ` (the path serves ${samePath.join(', ')})` : ''}`];
  }
  const violations: string[] = [];
  if (!entry.auth) violations.push(`${where}: mounted without requireAuth`);
  const actual = [...entry.internalCallers].sort().join(', ');
  const expected = [...contract.callers].sort().join(', ');
  if (actual !== expected) violations.push(`${where}: internal callers are [${actual}] but the contract names [${expected}]`);
  return violations;
}

/** One sample exchange for a contract. */
export interface ContractSample {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The success envelope's `data`. */
  response: unknown;
}

/** JSON round trip — what actually crosses the wire. */
const wire = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

/**
 * Push a sample through the contract. Throws (with the contract id) when any
 * part fails to parse, changes across a JSON round trip, or the built path does
 * not match the contract's route pattern. Returns the built path and the parsed
 * values so a test can assert on them.
 */
export function roundTripContractSample(contract: InternalEndpointContract, sample: ContractSample): {
  path: string; params: unknown; query: unknown; body: unknown; response: unknown;
} {
  const fail = (what: string, detail: string): never => {
    throw new Error(`${contract.id}: ${what} — ${detail}`);
  };
  const parse = (what: string, schema: InternalEndpointContract['response'] | undefined, value: unknown): unknown => {
    if (!schema) {
      if (value !== undefined) fail(what, 'the contract has no schema for it, but the sample sends one');
      return undefined;
    }
    const first = schema.safeParse(value);
    if (!first.success) fail(what, first.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const again = schema.safeParse(wire(first.data));
    if (!again.success) fail(`${what} (after JSON)`, again.error.issues.map((i) => i.message).join('; '));
    if (JSON.stringify(again.data) !== JSON.stringify(first.data)) fail(what, 'changed across a JSON round trip');
    return first.data;
  };

  const names = pathParamNames(contract.path);
  const sampleParams = sample.params ?? {};
  const missing = names.filter((n) => sampleParams[n] === undefined);
  if (missing.length) fail('params', `the sample omits ${missing.join(', ')}`);
  const params = parse('params', contract.params, Object.fromEntries(Object.entries(sampleParams).map(([k, v]) => [k, String(v)])));
  const query = contract.query ? parse('query', contract.query, sample.query ?? {}) : (sample.query ? fail('query', 'the contract reads no query') : undefined);
  const body = parse('body', contract.body, sample.body);
  const response = parse('response', contract.response, sample.response);

  const path = buildContractPath(contract, sampleParams, sample.query);
  const pattern = new RegExp(`^${contract.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z0-9_]+)/g, '[^/?]+')}(\\?.*)?$`);
  if (!pattern.test(path)) fail('path', `${path} does not match ${contract.path}`);
  return { path, params, query, body, response };
}
