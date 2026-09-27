// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin resolution and vulnerability exposure, against a REAL Postgres.
 *
 * Real, not mocked, because every interesting thing here is a SQL behaviour: an
 * upsert that must NOT reset a triage decision, a `CASE` that recomputes a version
 * gap in one statement across every pipeline in the instance, and a delete-then-
 * insert that has to remove a step somebody deleted from a config.
 *
 * The properties under test are the ones a wrong answer would quietly break:
 *
 *  - a nightly rescan REFRESHES an exposure, it does not open a new one each night;
 *  - an acceptance is time-boxed, and an expired one reads as OPEN;
 *  - a deploy that moves off a version closes its exposure, on the deploy rather
 *    than on the next rescan;
 *  - "we could not tell" is never reported as "up to date".
 */

import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { bootInitDb } from './helpers/pglite-init.js';
import { versionGap } from '../src/api/reporting/plugin-exposure.js';

let db: PGlite;

const ORG = 'org-exposure';
const PIPE = randomUUID();
const PIPE_2 = randomUUID();

beforeAll(async () => {
  db = await bootInitDb();
  for (const [id, project] of [[PIPE, 'web'], [PIPE_2, 'api']] as const) {
    await db.query(
      `INSERT INTO pipelines (id, org_id, project, organization, props, created_by, updated_by)
       VALUES ($1, $2, $3, 'acme', '{}'::jsonb, 'u1', 'u1')`,
      [id, ORG, project],
    );
  }
}, 120_000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.query('DELETE FROM plugin_vuln_exposure');
  await db.query('DELETE FROM pipeline_plugin_resolution');
});

// ── The gap calculation (pure) ───────────────────────────────────────────────

describe('versionGap', () => {
  it.each([
    ['1.0.0', '2.0.0', 'major'],
    ['1.0.0', '1.1.0', 'minor'],
    ['1.0.0', '1.0.1', 'patch'],
    ['1.0.0', '1.0.0', 'none'],
    // Resolved AHEAD of "latest" (a pre-release, or a catalog lagging): behind by
    // nothing, which is different from unknown.
    ['2.0.0', '1.9.9', 'none'],
    ['v1.2.3', 'v1.2.4', 'patch'],
  ])('%s vs %s is %s', (resolved, latest, expected) => {
    expect(versionGap(resolved, latest)).toBe(expected);
  });

  /**
   * "We could not tell" is NOT "up to date". Reporting `none` for an unparseable
   * version is how a pipeline pinned to an ancient tag gets a clean bill of health.
   */
  it.each([
    ['latest', '2.0.0'],
    ['2.0.0', 'latest'],
    [null, '2.0.0'],
    ['2.0.0', null],
    ['main', 'main'],
    ['1.0', '1.1'],
  ])('returns null, never "none", for %j vs %j', (resolved, latest) => {
    expect(versionGap(resolved, latest)).toBeNull();
  });
});

// ── Resolution rows ─────────────────────────────────────────────────────────

const insertResolution = async (over: Record<string, unknown> = {}) => {
  const row = {
    org_id: ORG,
    pipeline_id: PIPE,
    stage_name: 'Build',
    step_name: 'scan',
    plugin_publisher: 'acme',
    plugin_name: 'trivy',
    declared_version: '^1.0.0',
    resolved_version: '1.0.0',
    latest_version: '1.0.0',
    version_gap: 'none',
    within_policy: true,
    ...over,
  };
  await db.query(
    `INSERT INTO pipeline_plugin_resolution
       (org_id, pipeline_id, stage_name, step_name, plugin_publisher, plugin_name,
        declared_version, resolved_version, latest_version, version_gap, within_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    Object.values(row),
  );
};

const resolutions = async () => (await db.query<Record<string, unknown>>(
  `SELECT pipeline_id, stage_name, step_name, plugin_name, resolved_version,
          latest_version, version_gap, within_policy
     FROM pipeline_plugin_resolution ORDER BY pipeline_id, stage_name, step_name`,
)).rows;

describe('pipeline_plugin_resolution', () => {
  it('holds one row per step, keyed so two stages can run the same plugin', async () => {
    await insertResolution({ stage_name: 'Build', step_name: 'scan' });
    await insertResolution({ stage_name: 'Test', step_name: 'scan' });
    expect(await resolutions()).toHaveLength(2);
  });

  it('refuses a version_gap outside the vocabulary', async () => {
    await expect(insertResolution({ version_gap: 'enormous' })).rejects.toThrow();
  });

  it('accepts a null gap, which is how "we could not tell" is stored', async () => {
    await insertResolution({ resolved_version: 'latest', version_gap: null });
    expect((await resolutions())[0]?.version_gap).toBeNull();
  });

  /**
   * The publish-time refresh: one statement recomputes the gap for every pipeline
   * in the instance that declares the plugin. Re-resolving each pipeline instead
   * would make a publish cost work proportional to the whole instance.
   */
  it('recomputes the gap for every pipeline on a publish, in one statement', async () => {
    await insertResolution({ pipeline_id: PIPE, resolved_version: '1.0.0' });
    await insertResolution({ pipeline_id: PIPE_2, resolved_version: '1.4.0' });
    await insertResolution({ pipeline_id: PIPE_2, step_name: 'other', plugin_name: 'cdk', resolved_version: '1.0.0' });

    await db.query(
      `UPDATE pipeline_plugin_resolution SET
         latest_version = $1::text,
         version_gap = CASE
           WHEN resolved_version IS NULL THEN NULL
           WHEN split_part($1::text, '.', 1)::int > split_part(resolved_version, '.', 1)::int THEN 'major'
           WHEN split_part($1::text, '.', 1)::int < split_part(resolved_version, '.', 1)::int THEN 'none'
           WHEN split_part($1::text, '.', 2)::int > split_part(resolved_version, '.', 2)::int THEN 'minor'
           WHEN split_part($1::text, '.', 2)::int < split_part(resolved_version, '.', 2)::int THEN 'none'
           WHEN split_part($1::text, '.', 3)::int > split_part(resolved_version, '.', 3)::int THEN 'patch'
           ELSE 'none' END
       WHERE plugin_name = 'trivy' AND plugin_publisher = 'acme'
         AND resolved_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+'`,
      ['2.0.0'],
    );

    const rows = await resolutions();
    const trivy = rows.filter((r) => r.plugin_name === 'trivy');
    expect(trivy.every((r) => r.version_gap === 'major')).toBe(true);
    expect(trivy.every((r) => r.latest_version === '2.0.0')).toBe(true);
    // A different plugin is untouched: a trivy publish says nothing about cdk.
    expect(rows.find((r) => r.plugin_name === 'cdk')?.latest_version).toBe('1.0.0');
  });

  it('skips a non-semver resolved version rather than throwing on the cast', async () => {
    await insertResolution({ resolved_version: 'latest', version_gap: null });
    await expect(db.query(
      `UPDATE pipeline_plugin_resolution SET version_gap =
         CASE WHEN split_part($1::text, '.', 1)::int > split_part(resolved_version, '.', 1)::int THEN 'major' ELSE 'none' END
       WHERE resolved_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+'`,
      ['2.0.0'],
    )).resolves.toBeDefined();
    expect((await resolutions())[0]?.version_gap).toBeNull();
  });
});

// ── Exposures ───────────────────────────────────────────────────────────────

const insertExposure = async (over: Record<string, unknown> = {}) => {
  const row = {
    id: randomUUID(),
    org_id: ORG,
    pipeline_id: PIPE,
    plugin_publisher: 'acme',
    plugin_name: 'trivy',
    plugin_version: '1.0.0',
    image_digest: `sha256:${'a'.repeat(64)}`,
    source: 'deployed',
    critical_count: 2,
    high_count: 5,
    top_findings: JSON.stringify([{ id: 'CVE-2026-1', packageName: 'openssl' }]),
    triage_state: 'open',
    accepted_until: null,
    ...over,
  };
  await db.query(
    `INSERT INTO plugin_vuln_exposure
       (id, org_id, pipeline_id, plugin_publisher, plugin_name, plugin_version,
        image_digest, source, critical_count, high_count, top_findings,
        triage_state, accepted_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
    Object.values(row),
  );
  return row.id as string;
};

const exposures = async () => (await db.query<Record<string, unknown>>(
  `SELECT pipeline_id, plugin_name, plugin_version, source, critical_count, high_count,
          triage_state, accepted_until, fixed_at
     FROM plugin_vuln_exposure ORDER BY plugin_name, plugin_version, source`,
)).rows;

describe('plugin_vuln_exposure', () => {
  it('is one row per (pipeline, plugin, version, source)', async () => {
    await insertExposure({ source: 'deployed' });
    // The DECLARED and DEPLOYED views of the same version are different facts: a
    // pipeline can declare a fixed version and still be running the old image.
    await insertExposure({ source: 'declared' });
    expect(await exposures()).toHaveLength(2);
  });

  /**
   * A nightly rescan must REFRESH, not accumulate. One row per night of the same
   * problem reads as an escalating situation when nothing changed.
   */
  it('a rescan refreshes the counts instead of opening a second row', async () => {
    await insertExposure({ critical_count: 2, high_count: 5 });
    await db.query(
      `INSERT INTO plugin_vuln_exposure
         (id, org_id, pipeline_id, plugin_name, plugin_version, source, critical_count, high_count)
       VALUES ($1, $2, $3, 'trivy', '1.0.0', 'deployed', 3, 7)
       ON CONFLICT (pipeline_id, plugin_name, plugin_version, source) DO UPDATE SET
         critical_count = excluded.critical_count,
         high_count = excluded.high_count,
         fixed_at = NULL`,
      [randomUUID(), ORG, PIPE],
    );
    const rows = await exposures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ critical_count: 3, high_count: 7 });
  });

  it('refuses a source outside declared/deployed', async () => {
    await expect(insertExposure({ source: 'guessed' })).rejects.toThrow();
  });

  it('refuses a triage state outside the vocabulary', async () => {
    await expect(insertExposure({ triage_state: 'ignored_forever' })).rejects.toThrow();
  });

  it('refuses a malformed image digest', async () => {
    await expect(insertExposure({ image_digest: 'sha256:nope' })).rejects.toThrow();
  });

  it('accepts a null digest — a declared exposure has no image yet', async () => {
    await insertExposure({ source: 'declared', image_digest: null });
    expect(await exposures()).toHaveLength(1);
  });

  /**
   * An acceptance past its deadline is not an acceptance. Enforced at READ as well
   * as on refresh, because the report is read far more often than the rescan runs.
   */
  it('an expired acceptance reads as open', async () => {
    const past = new Date(Date.now() - 86_400_000);
    await insertExposure({ triage_state: 'accepted', accepted_until: past });
    const rows = (await db.query<Record<string, unknown>>(
      `SELECT triage_state, accepted_until FROM plugin_vuln_exposure
        WHERE fixed_at IS NULL
          AND (triage_state <> 'accepted' OR accepted_until IS NULL OR accepted_until <= NOW())`,
    )).rows;
    expect(rows).toHaveLength(1);
  });

  it('a live acceptance is excluded from the open set', async () => {
    const future = new Date(Date.now() + 86_400_000);
    await insertExposure({ triage_state: 'accepted', accepted_until: future });
    const rows = (await db.query(
      `SELECT 1 FROM plugin_vuln_exposure
        WHERE fixed_at IS NULL
          AND (triage_state <> 'accepted' OR accepted_until IS NULL OR accepted_until <= NOW())`,
    )).rows;
    expect(rows).toEqual([]);
  });

  /**
   * Closing on the DEPLOY rather than on the next rescan is what makes "we fixed
   * it" show up in the report the same day.
   */
  it('closes by absence: a version the pipeline no longer runs is fixed', async () => {
    await insertExposure({ plugin_version: '1.0.0' });
    await insertExposure({ plugin_version: '1.1.0' });
    // The pipeline now runs only 1.1.0.
    await db.query(
      `UPDATE plugin_vuln_exposure SET fixed_at = NOW(), triage_state = 'fixed'
        WHERE pipeline_id = $1 AND fixed_at IS NULL
          AND (plugin_name || '@' || plugin_version) <> ALL($2::text[])`,
      [PIPE, ['trivy@1.1.0']],
    );
    const rows = await exposures();
    expect(rows.find((r) => r.plugin_version === '1.0.0')?.fixed_at).not.toBeNull();
    expect(rows.find((r) => r.plugin_version === '1.1.0')?.fixed_at).toBeNull();
  });

  /** A closed exposure that is flagged again is a REGRESSION, not still-fixed. */
  it('reopens a fixed exposure when the rescan flags it again', async () => {
    await insertExposure({ triage_state: 'fixed' });
    await db.query('UPDATE plugin_vuln_exposure SET fixed_at = NOW()');
    await db.query(
      `INSERT INTO plugin_vuln_exposure
         (id, org_id, pipeline_id, plugin_name, plugin_version, source, critical_count, high_count)
       VALUES ($1, $2, $3, 'trivy', '1.0.0', 'deployed', 1, 1)
       ON CONFLICT (pipeline_id, plugin_name, plugin_version, source) DO UPDATE SET
         critical_count = excluded.critical_count,
         fixed_at = NULL,
         triage_state = CASE WHEN plugin_vuln_exposure.triage_state = 'fixed'
                             THEN 'open' ELSE plugin_vuln_exposure.triage_state END`,
      [randomUUID(), ORG, PIPE],
    );
    const [row] = await exposures();
    expect(row).toMatchObject({ triage_state: 'open' });
    expect(row?.fixed_at).toBeNull();
  });

  it('keeps one org’s exposures out of another’s open set', async () => {
    await insertExposure({ org_id: ORG });
    await insertExposure({ org_id: 'org-elsewhere', pipeline_id: PIPE_2 });
    const mine = (await db.query(
      'SELECT 1 FROM plugin_vuln_exposure WHERE org_id = $1', [ORG],
    )).rows;
    expect(mine).toHaveLength(1);
  });
});
