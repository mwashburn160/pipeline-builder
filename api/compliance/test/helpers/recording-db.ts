// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connection-less Drizzle transaction for tests that need the REAL query
 * construction (real pipeline-data schema + builders + drizzle) without a
 * database. Every awaited statement is rendered with `toSQL()` into `statements`
 * and resolves to the next canned result from `results` (FIFO; `[]` when empty).
 *
 * Unlike a hand-rolled chain stub, the SQL is built by drizzle itself, so a test
 * can assert what a query actually filters on (e.g. a `scope = 'org'` predicate
 * or an `ON CONFLICT … WHERE deleted_at IS NOT NULL` guard).
 */
import { drizzle } from 'drizzle-orm/node-postgres';

export interface RecordedStatement {
  sql: string;
  params: unknown[];
}

export interface RecordingDb {
  /** Statements executed so far, in execution order. */
  statements: RecordedStatement[];
  /** Canned results, consumed one per executed statement. */
  results: unknown[][];
  /** The fake transaction handed to `withTenantTx` callbacks. */
  tx: Record<string, (...args: never[]) => unknown>;
  reset(): void;
}

export function createRecordingDb(): RecordingDb {
  const db = drizzle.mock();
  const state: RecordingDb = {
    statements: [],
    results: [],
    tx: {},
    reset() {
      state.statements.length = 0;
      state.results.length = 0;
    },
  };

  const record = <T extends object>(builder: T): T => new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        return (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => {
          state.statements.push((target as unknown as { toSQL(): RecordedStatement }).toSQL());
          const next = state.results.length > 0 ? state.results.shift() : [];
          return Promise.resolve(next).then(onOk, onErr);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out !== null && typeof out === 'object' ? record(out) : out;
      };
    },
  });

  state.tx = {
    select: (...args: never[]) => record((db.select as (...a: never[]) => object)(...args)),
    insert: (table: never) => record(db.insert(table)),
    update: (table: never) => record(db.update(table)),
    delete: (table: never) => record(db.delete(table)),
  };
  return state;
}

/** Params bound to `"<column>" = $n` predicates in a rendered statement. */
export function paramsForColumn(stmt: RecordedStatement, column: string): unknown[] {
  const re = new RegExp(`"${column}" = \\$(\\d+)`, 'g');
  return [...stmt.sql.matchAll(re)].map((m) => stmt.params[Number(m[1]) - 1]);
}
