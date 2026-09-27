// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A recording stand-in for the Drizzle transaction handed to `withTenantTx`.
 *
 * Hand-stubbing `{ values: () => ({ onConflictDoUpdate: () => ({ returning: … }) }) }`
 * per test couples each assertion to the exact builder chain the code happens to
 * use today, so a harmless refactor (adding `.limit()`, reordering `.where()`)
 * breaks suites that were not testing that. This instead records the chain and
 * hands back queued results, which lets a test assert the two things that
 * actually matter — the VALUES/SET payload and the rendered WHERE — without
 * pinning the chain's shape.
 *
 * The rendered SQL comes from `PgDialect().sqlToQuery()`, the same mechanism the
 * schema-drift suites use.
 */

import { type SQL, is } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { SQL as SQLClass } from 'drizzle-orm/sql/sql';

/** One builder call in a recorded chain. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** One statement: its chain of builder calls, in order. */
export interface RecordedQuery {
  calls: RecordedCall[];
  /** `insert` / `select` / `update` / `delete` — the chain's first call. */
  kind: string;
  /** The table the statement targets, when the first call named one. */
  table?: string;
  /** The argument of the named builder call, or undefined when it was not used. */
  arg(method: string): unknown;
  /** The rendered SQL of the first `where(...)`, for asserting predicates. */
  whereSql(): string;
}

const dialect = new PgDialect();

/** Render a drizzle `SQL` fragment to its parameterized text. */
export function renderSql(fragment: unknown): string {
  if (!is(fragment, SQLClass)) return '';
  return dialect.sqlToQuery(fragment as SQL).sql;
}

function tableName(value: unknown): string | undefined {
  // Drizzle stores the name on a well-known symbol; reading it by description
  // keeps this independent of the symbol's identity across module instances.
  if (value === null || typeof value !== 'object') return undefined;
  for (const sym of Object.getOwnPropertySymbols(value)) {
    if (sym.description?.includes('Name') && !sym.description.includes('Original')) {
      const name = (value as unknown as Record<symbol, unknown>)[sym];
      if (typeof name === 'string') return name;
    }
  }
  return undefined;
}

/** A fake tx plus the log of every statement built through it. */
export interface FakeTx {
  /** Pass this where the code expects the Drizzle transaction. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  /** Every statement built, in order. */
  queries: RecordedQuery[];
  /** Queue the rows the next awaited statement resolves to. */
  queue(...results: unknown[][]): void;
  /**
   * Queue rows DERIVED from the statement that asks for them — for the cases
   * where the code round-trips a value it generated (a minted token hash) and the
   * test has no way to know it in advance.
   */
  queueFrom(build: (query: RecordedQuery) => unknown[]): void;
  /** Statements whose chain starts with `kind`. */
  of(kind: string): RecordedQuery[];
  reset(): void;
}

/**
 * Build a recording fake transaction.
 *
 * Results are a QUEUE: each awaited statement takes the next entry, so a test
 * lists the rows its statements return in the order the code runs them. An empty
 * queue resolves to `[]`, which is what "no rows matched" looks like — the case
 * most of these methods have a branch for.
 */
export function fakeTx(): FakeTx {
  const queries: RecordedQuery[] = [];
  type Result = unknown[] | { derive: (q: RecordedQuery) => unknown[] };
  const results: Result[] = [];

  const settle = async (query: RecordedQuery): Promise<unknown> => {
    const next = results.shift();
    if (next && !Array.isArray(next) && typeof next === 'object' && 'derive' in next) return next.derive(query);
    return next ?? [];
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain = (kind: string, first: unknown[]): any => {
    const calls: RecordedCall[] = [{ method: kind, args: first }];
    const record: RecordedQuery = {
      calls,
      kind,
      ...(tableName(first[0]) ? { table: tableName(first[0]) } : {}),
      arg: (method) => calls.find((c) => c.method === method)?.args[0],
      whereSql: () => renderSql(calls.find((c) => c.method === 'where')?.args[0]),
    };
    queries.push(record);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proxy: any = new Proxy({}, {
      get(_target, prop) {
        // Awaiting the chain runs it. `catch`/`finally` come for free once
        // `then` exists, because the store only ever awaits.
        if (prop === 'then') {
          return (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => settle(record).then(onOk, onErr);
        }
        if (typeof prop === 'symbol') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  };

  return {
    tx: {
      select: (...args: unknown[]) => chain('select', args),
      insert: (...args: unknown[]) => chain('insert', args),
      update: (...args: unknown[]) => chain('update', args),
      delete: (...args: unknown[]) => chain('delete', args),
      execute: (...args: unknown[]) => chain('execute', args),
    },
    queries,
    queue: (...rows: unknown[][]) => { results.push(...rows); },
    queueFrom: (build: (q: RecordedQuery) => unknown[]) => { results.push({ derive: build }); },
    of: (kind: string) => queries.filter((q) => q.kind === kind),
    reset: () => { queries.length = 0; results.length = 0; },
  };
}
