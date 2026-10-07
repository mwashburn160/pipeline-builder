// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Make the deployed MongoDB indexes match the schemas, at boot.
 *
 * Mongoose's auto-indexing calls `createIndexes`, which creates an index that is
 * MISSING and does nothing at all to one that already exists under the same
 * name — even when its definition has since changed. So a schema index edit is
 * applied to new databases and silently never applied to existing ones, and the
 * two drift apart with nothing reporting it.
 *
 * That is not theoretical. `role_assignments` declared
 *
 *   { userId: 1, roleId: 1 } unique
 *
 * and was changed on 2026-09-18 to add
 *
 *   partialFilterExpression: { userId: { $type: 'objectId' } }
 *
 * because a service-account assignment stores `userId: null`, and a plain
 * unique index treats every null as the same key — so the SECOND service
 * account to hold any given Role collided with the first. Databases created
 * before that date kept the old index, and no rebuild or redeploy would ever
 * replace it. It surfaced as `store-token` failing with a 409 that named a
 * duplicate key the operator had no way to connect to a stale index:
 *
 *   E11000 duplicate key error collection: platform.role_assignments
 *   index: userId_1_roleId_1 dup key: { userId: null, roleId: ... }
 *
 * WHAT THIS DOES, AND DELIBERATELY DOES NOT DO
 *
 * It drops and recreates only indexes that CONFLICT: same name, different
 * definition. That is exactly the case Mongoose cannot handle and the one that
 * breaks writes.
 *
 * An index in the database that no schema declares is REPORTED, never dropped.
 * A blanket `syncIndexes()` would remove it, and the thing most likely to be in
 * that set is an index an operator added by hand to rescue a slow query under
 * load. Deleting it during a routine restart, silently, is a worse failure than
 * the drift being fixed — so the loud log and the metric are the whole response.
 *
 * Nothing here blocks boot. A reconcile failure is logged and counted: the
 * service is still able to serve, and a restart loop would turn an index
 * problem into an outage.
 */

import { createLogger, errorMessage } from '@pipeline-builder/api-core';
import type { Model } from 'mongoose';
import mongoose from 'mongoose';
import { incCounter, setGauge } from '../observability/metrics.js';

const logger = createLogger('index-reconcile');

/** What a pass changed and what it left alone, so callers (and tests) can assert on it. */
export interface ReconcileResult {
  /** Indexes dropped and recreated because their definition had changed. */
  rebuilt: string[];
  /** Indexes present in the database that no schema declares. Reported only. */
  unknown: string[];
  /** Collections whose reconcile threw (missing collection, no permission, …). */
  failed: string[];
}

/** Mongo index metadata, narrowed to the fields that decide equality. */
interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
}

/**
 * Whether a live index and a declared one are the same index.
 *
 * Compared on the options that change BEHAVIOUR — the key order (a compound
 * index is order-sensitive), uniqueness, sparseness, the partial filter and the
 * TTL. Cosmetic fields the server adds (`v`, `ns`, `background`) are ignored:
 * including them would mark every index as drifted on a server upgrade and
 * rebuild the lot.
 */
function sameIndex(live: IndexInfo, declared: IndexInfo): boolean {
  const key = (i: IndexInfo) => JSON.stringify(Object.entries(i.key));
  const filter = (i: IndexInfo) => JSON.stringify(i.partialFilterExpression ?? null);
  return key(live) === key(declared)
    && !!live.unique === !!declared.unique
    && !!live.sparse === !!declared.sparse
    && filter(live) === filter(declared)
    && (live.expireAfterSeconds ?? null) === (declared.expireAfterSeconds ?? null);
}

/** The schema's indexes, named the way Mongo names them, so live ones can be matched. */
function declaredIndexes(model: Model<unknown>): IndexInfo[] {
  return model.schema.indexes().map(([key, options]) => {
    const opts = (options ?? {}) as Partial<IndexInfo>;
    const name = opts.name ?? Object.entries(key).map(([f, dir]) => `${f}_${String(dir)}`).join('_');
    return { ...opts, name, key: key as Record<string, unknown> };
  });
}

/**
 * Reconcile one model. Exported for the test, which plants a conflicting index
 * and asserts it is rebuilt — the behaviour is not worth much unproven.
 */
export async function reconcileModel(model: Model<unknown>): Promise<ReconcileResult> {
  const result: ReconcileResult = { rebuilt: [], unknown: [], failed: [] };
  const declared = declaredIndexes(model);
  let live: IndexInfo[];
  try {
    live = (await model.listIndexes()) as unknown as IndexInfo[];
  } catch (err) {
    // A collection that does not exist yet has no indexes to reconcile — the
    // first write creates it and Mongoose indexes it correctly. Anything else
    // is worth a line.
    const msg = errorMessage(err);
    if (!/ns does not exist|NamespaceNotFound/i.test(msg)) {
      result.failed.push(model.collection.name);
      logger.warn('Could not list indexes', { collection: model.collection.name, error: msg });
    }
    return result;
  }

  for (const existing of live) {
    if (existing.name === '_id_') continue;
    const match = declared.find((d) => d.name === existing.name);
    if (!match) {
      result.unknown.push(`${model.collection.name}.${existing.name}`);
      continue;
    }
    if (sameIndex(existing, match)) continue;
    try {
      // Drop then let Mongoose recreate from the schema. Briefly unindexed —
      // acceptable at boot, before this instance serves traffic, and the
      // alternative is a definition that stays wrong forever.
      await model.collection.dropIndex(existing.name);
      await model.createIndexes();
      result.rebuilt.push(`${model.collection.name}.${existing.name}`);
      logger.warn('Rebuilt an index whose definition had changed', {
        collection: model.collection.name,
        index: existing.name,
        was: { unique: !!existing.unique, partial: existing.partialFilterExpression ?? null },
        now: { unique: !!match.unique, partial: match.partialFilterExpression ?? null },
      });
    } catch (err) {
      result.failed.push(`${model.collection.name}.${existing.name}`);
      logger.error('Could not rebuild a drifted index — writes may still fail against it', {
        collection: model.collection.name, index: existing.name, error: errorMessage(err),
      });
    }
  }
  return result;
}

/**
 * Reconcile every registered model. Called once after the Mongo connection is
 * up and before the server accepts traffic.
 */
export async function reconcileIndexes(): Promise<ReconcileResult> {
  const total: ReconcileResult = { rebuilt: [], unknown: [], failed: [] };
  for (const name of mongoose.modelNames()) {
    const r = await reconcileModel(mongoose.model(name) as unknown as Model<unknown>);
    total.rebuilt.push(...r.rebuilt);
    total.unknown.push(...r.unknown);
    total.failed.push(...r.failed);
  }

  for (const n of total.rebuilt) incCounter('mongo_index_rebuilt_total', { index: n });
  // Gauges rather than counters: both are STATES of the deployment, and an
  // operator wants to know "is there drift right now", not how many times a
  // restart noticed it.
  setGauge('mongo_index_unknown', {}, total.unknown.length);
  setGauge('mongo_index_reconcile_failed', {}, total.failed.length);

  if (total.unknown.length > 0) {
    // Reported, never dropped — see the module comment. Most likely an index an
    // operator added by hand to rescue a slow query.
    logger.warn('Indexes exist that no schema declares; leaving them alone', { indexes: total.unknown });
  }
  logger.info('Index reconcile complete', {
    models: mongoose.modelNames().length,
    rebuilt: total.rebuilt.length,
    unknown: total.unknown.length,
    failed: total.failed.length,
  });
  return total;
}
