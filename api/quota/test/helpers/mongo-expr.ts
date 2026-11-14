// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal evaluator for the Mongo aggregation-expression subset the quota
 * service's atomic increments are built from — so a suite can run a filter
 * `$expr` (and an update stage) against a document and assert what MONGO would
 * decide, rather than only the expression's shape.
 *
 * The suites mock the Organization model wholesale, so without this an
 * increment filter that admitted the wrong thing passed every test as long as
 * it was the right JSON. Only the operators the service emits are supported;
 * anything else throws, so a new operator cannot be silently misread.
 *
 * Comparison follows BSON order for the types that occur here: missing/null
 * sorts below numbers, numbers below dates — which is what makes an ABSENT
 * `resetAt` read as "expired" (`$lte: [missing, $$NOW]` is true).
 */

type Doc = Record<string, unknown>;

/** Realm-safe: a value cloned across the jest VM boundary fails `instanceof Date`. */
const isDate = (v: unknown): v is Date => Object.prototype.toString.call(v) === '[object Date]';

/** Deep copy that keeps Dates as Dates (structuredClone's come back from another realm). */
function clone<T>(v: T): T {
  if (isDate(v)) return new Date(v.getTime()) as T;
  if (Array.isArray(v)) return v.map(clone) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  return v;
}

function rank(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return 1;
  if (typeof v === 'string') return 2;
  if (isDate(v)) return 9;
  return 3;
}

function compare(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const x = isDate(a) ? a.getTime() : (a as number | string);
  const y = isDate(b) ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function getPath(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Doc)[part];
  }
  return cur;
}

function bsonType(v: unknown): string {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (isDate(v)) return 'date';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'bool';
  return 'object';
}

const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0;

/** Evaluate `expr` against `doc`, with `$$NOW` = `now`. */
export function evalExpr(expr: unknown, doc: Doc, now: Date): unknown {
  const ev = (e: unknown) => evalExpr(e, doc, now);
  if (typeof expr === 'string') {
    if (expr === '$$NOW') return now;
    if (expr.startsWith('$')) return getPath(doc, expr.slice(1));
    return expr;
  }
  if (expr === null || typeof expr !== 'object' || isDate(expr)) return expr;
  if (Array.isArray(expr)) return expr.map(ev);

  const entries = Object.entries(expr as Doc);
  if (entries.length !== 1 || !entries[0]![0].startsWith('$')) {
    return Object.fromEntries(entries.map(([k, v]) => [k, ev(v)]));
  }
  const [op, arg] = entries[0]!;
  const args = (Array.isArray(arg) ? arg : [arg]) as unknown[];
  switch (op) {
    case '$ifNull': {
      for (const a of args.slice(0, -1)) {
        const v = ev(a);
        if (v !== undefined && v !== null) return v;
      }
      return ev(args[args.length - 1]);
    }
    case '$cond': {
      const c = Array.isArray(arg) ? { if: arg[0], then: arg[1], else: arg[2] } : (arg as { if: unknown; then: unknown; else: unknown });
      return truthy(ev(c.if)) ? ev(c.then) : ev(c.else);
    }
    case '$switch': {
      const s = arg as { branches: Array<{ case: unknown; then: unknown }>; default: unknown };
      for (const b of s.branches) if (truthy(ev(b.case))) return ev(b.then);
      return ev(s.default);
    }
    case '$and': return args.every((a) => truthy(ev(a)));
    case '$or': return args.some((a) => truthy(ev(a)));
    case '$not': return !truthy(ev(args[0]));
    case '$eq': return compare(ev(args[0]), ev(args[1])) === 0;
    case '$lte': return compare(ev(args[0]), ev(args[1])) <= 0;
    case '$lt': return compare(ev(args[0]), ev(args[1])) < 0;
    case '$gt': return compare(ev(args[0]), ev(args[1])) > 0;
    case '$gte': return compare(ev(args[0]), ev(args[1])) >= 0;
    case '$type': return bsonType(ev(args[0]));
    case '$isNumber': return typeof ev(args[0]) === 'number';
    case '$add': {
      const vs = args.map(ev);
      if (vs.some((v) => v === undefined || v === null)) return null;
      return (vs as number[]).reduce((a, b) => a + b, 0);
    }
    case '$subtract': {
      const [a, b] = args.map(ev) as [number | null, number | null];
      return a === null || a === undefined || b === null || b === undefined ? null : a - b;
    }
    case '$multiply': return (args.map(ev) as number[]).reduce((a, b) => a * b, 1);
    case '$divide': { const [a, b] = args.map(ev) as [number, number]; return a / b; }
    case '$floor': return Math.floor(ev(args[0]) as number);
    case '$max': {
      const vs = args.map(ev).filter((v) => v !== undefined && v !== null) as number[];
      return vs.length ? Math.max(...vs) : null;
    }
    case '$dateAdd': {
      const d = arg as { startDate: unknown; unit: string; amount: unknown };
      if (d.unit !== 'day') throw new Error(`mongo-expr: unsupported $dateAdd unit ${d.unit}`);
      return new Date((ev(d.startDate) as Date).getTime() + (ev(d.amount) as number) * 86_400_000);
    }
    default:
      throw new Error(`mongo-expr: unsupported operator ${op}`);
  }
}

/** Does a `findOneAndUpdate` filter's `$expr` admit `doc`? (Other filter keys are the caller's concern.) */
export function exprAdmits(filter: { $expr?: unknown }, doc: Doc, now: Date = new Date()): boolean {
  return filter.$expr === undefined ? true : truthy(evalExpr(filter.$expr, doc, now));
}

/** Apply an aggregation-pipeline update of `$set` stages to a copy of `doc`, as Mongo would. */
export function applyPipeline(stages: Array<{ $set: Doc }>, doc: Doc, now: Date = new Date()): Doc {
  let cur: Doc = clone(doc);
  for (const stage of stages) {
    // Every expression in one stage reads the PRE-stage document.
    const values = Object.entries(stage.$set).map(([path, e]) => [path, evalExpr(e, cur, now)] as const);
    const next = clone(cur);
    for (const [path, value] of values) {
      const parts = path.split('.');
      let node = next;
      for (const p of parts.slice(0, -1)) {
        if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
        node = node[p] as Doc;
      }
      node[parts[parts.length - 1]!] = value;
    }
    cur = next;
  }
  return cur;
}
