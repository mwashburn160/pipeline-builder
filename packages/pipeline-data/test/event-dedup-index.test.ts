// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `event_dedup_idx` must not swallow GENUINE retries. The composite key
 * (pipeline, execution, type, status, stage, action) repeats when a stage or
 * action is retried inside one execution, so an event that carries an
 * EventBridge id dedups on that id alone (`event_source_event_idx`) and the
 * composite index covers only events without one (plugin-build).
 *
 * Runs against PGlite with the shipped init script (`postgres-init.sql`,
 * which only runs on new installs — there are no migrations).
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { pipelineEvent } from '../src/database/schema/pipeline.js';
import { bootInitDb } from '../src/testing/pglite-init.js';

let db: PGlite;
beforeAll(async () => {
  db = await bootInitDb();
}, 120_000);
afterAll(async () => { await db?.close(); });

const ORG = 'org-dedup';
async function insert(sourceEventId: string | null, executionId = 'exec-1'): Promise<number> {
  const r = await db.query(
    `INSERT INTO pipeline_events (org_id, event_source, event_type, status, execution_id, stage_name, source_event_id)
     VALUES ($1, 'codepipeline', 'STAGE', 'FAILED', $2, 'Build', $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [ORG, executionId, sourceEventId]);
  return r.rows.length;
}

describe('event_dedup_idx', () => {
  it('keeps a genuine retry: same composite key, distinct EventBridge ids', async () => {
    expect(await insert('evb-1')).toBe(1);
    expect(await insert('evb-2')).toBe(1);
  });

  it('still dedups a redelivery of the SAME EventBridge event', async () => {
    expect(await insert('evb-3', 'exec-2')).toBe(1);
    expect(await insert('evb-3', 'exec-2')).toBe(0);
  });

  it('still dedups a re-recorded event with no source id (plugin-build retry) on the composite key', async () => {
    expect(await insert(null, 'exec-3')).toBe(1);
    expect(await insert(null, 'exec-3')).toBe(0);
  });

  it('the drizzle index declares the same predicate as the init script', async () => {
    const idx = getTableConfig(pipelineEvent).indexes.find((i) => i.config.name === 'event_dedup_idx');
    const where = idx?.config.where ? new PgDialect().sqlToQuery(idx.config.where).sql : '';
    expect(where).toBe('execution_id IS NOT NULL AND source_event_id IS NULL');
    // The index the init script actually built carries that predicate.
    const r = await db.query<{ indexdef: string }>('SELECT indexdef FROM pg_indexes WHERE indexname = \'event_dedup_idx\'');
    expect(r.rows[0]?.indexdef).toMatch(/WHERE \(+execution_id IS NOT NULL\)? AND \(?source_event_id IS NULL\)+$/);
  });
});
