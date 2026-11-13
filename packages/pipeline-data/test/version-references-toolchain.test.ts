// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The removal rule for a MANAGED TOOLCHAIN release (docs/plans/
 * bootstrap-image-versioning.md §4/§5) against REAL SQL: the shipped
 * `postgres-init.sql` on PGlite, read as the application role under the
 * elevated scope every removal path uses.
 *
 * A pipeline whose deployed manifest records the release ONLY through its
 * non-step `build-image` row (the bootstrap half) references BOTH halves —
 * the release is one unit — so `findVersionReferences` (delete) and the purge
 * predicate (tombstone purge, the retention sweep) hold either half.
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { SYSTEM_ORG, asTenant, bootInitDb } from './helpers/pglite-init.js';
import { findVersionReferences, versionReferencedPredicate } from '../src/api/version-references.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  pg = await bootInitDb();
  db = drizzle(pg);
}, 120_000);
afterAll(async () => { await pg?.close(); });

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const BOOT_DIGEST = `sha256:${'b'.repeat(64)}`;
const SYNTH_DIGEST = `sha256:${'c'.repeat(64)}`;

/** The removal paths' elevated read, bound to PGlite. */
const elevated = <T>(fn: (tx: any) => Promise<T>): Promise<T> => asTenant(pg, { isSysadmin: true }, () => fn(db));

let pipelineId: string;

async function half(name: 'pipeline-bootstrap' | 'cdk-synth', version: string, digest: string, deleted = false): Promise<void> {
  await pg.query(
    `INSERT INTO plugins (org_id, name, version, created_by, updated_by, plugin_type, image_digest, is_active, is_default, deleted_at)
     VALUES ($1, $2, $3, 't', 't', $4, $5, $6, false, $7)`,
    [SYSTEM_ORG, name, version, name === 'pipeline-bootstrap' ? 'BuildImage' : 'CodeBuildStep', digest, !deleted, deleted ? new Date() : null],
  );
}

/** A deployed manifest holding ONLY the release's build-image row (a custom synth plugin, say). */
async function buildImageOnly(version: string, digest = BOOT_DIGEST): Promise<void> {
  await pg.query(
    `INSERT INTO pipeline_step_manifests (pipeline_id, org_id, stage_name, action_name, plugin_name, plugin_version, image_digest, image_repository, step_key, resolved_via)
     VALUES ($1, $2, '(toolchain)', 'build-image', 'pipeline-bootstrap', $3, $4, 'system/pipeline-bootstrap', 'build-image', 'default')`,
    [pipelineId, ORG, version, digest],
  );
}

/** The purge predicate over the system org's tombstoned rows: which ones the sweep may purge. */
async function purgeable(): Promise<string[]> {
  const rows = await elevated((tx) => tx.execute(sql`
    SELECT plugins.name || '@' || plugins.version AS row FROM plugins
     WHERE plugins.deleted_at IS NOT NULL
       AND NOT ${versionReferencedPredicate({ digest: sql`plugins.image_digest`, name: sql`plugins.name`, version: sql`plugins.version`, orgId: sql`plugins.org_id` })}
     ORDER BY 1`));
  return (rows as unknown as { rows: Array<{ row: string }> }).rows.map((r) => r.row);
}

beforeEach(async () => {
  await pg.exec('DELETE FROM pipeline_step_manifests; DELETE FROM pipeline_plugin_resolution; DELETE FROM plugins; DELETE FROM pipelines;');
  const r = await pg.query<{ id: string }>(
    'INSERT INTO pipelines (org_id, project, organization, pipeline_name, created_by, updated_by) VALUES ($1, \'web\', \'acme\', \'web-pipeline\', \'u\', \'u\') RETURNING id',
    [ORG],
  );
  pipelineId = r.rows[0]!.id;
});

describe('a release referenced only through the build-image row', () => {
  it('references the bootstrap half (by digest) under the build-image step key', async () => {
    await half('pipeline-bootstrap', '1.4.2', BOOT_DIGEST);
    await buildImageOnly('1.4.2');
    const refs = await findVersionReferences({ pluginName: 'pipeline-bootstrap', pluginVersion: '1.4.2', imageDigest: BOOT_DIGEST, ownerOrgId: SYSTEM_ORG }, elevated);
    expect(refs).toEqual([{ pipelineId, pipelineName: 'web-pipeline', orgId: ORG, source: 'deployed', pipelineDeleted: false, steps: ['build-image'] }]);
  });

  it('references the synth half too: the release is one unit', async () => {
    await buildImageOnly('1.4.2');
    const refs = await findVersionReferences({ pluginName: 'cdk-synth', pluginVersion: '1.4.2', imageDigest: SYNTH_DIGEST, ownerOrgId: SYSTEM_ORG }, elevated);
    expect(refs.map((r) => [r.pipelineId, r.source, r.steps])).toEqual([[pipelineId, 'deployed', ['build-image']]]);
    // Another release of the same names is not held by it.
    expect(await findVersionReferences({ pluginName: 'cdk-synth', pluginVersion: '1.4.3', imageDigest: SYNTH_DIGEST, ownerOrgId: SYSTEM_ORG }, elevated)).toEqual([]);
  });

  it('only the system org\'s managed rows match release-wide (a tenant row named alike does not)', async () => {
    await buildImageOnly('1.4.2');
    expect(await findVersionReferences({ pluginName: 'cdk-synth', pluginVersion: '1.4.2', imageDigest: SYNTH_DIGEST, ownerOrgId: ORG }, elevated)).toEqual([]);
    expect(await findVersionReferences({ pluginName: 'cdk-synth', pluginVersion: '1.4.2', imageDigest: SYNTH_DIGEST, publisher: 'acme' }, elevated)).toEqual([]);
  });

  it('the purge predicate holds BOTH tombstoned halves while the build-image row exists, and releases them after', async () => {
    await half('pipeline-bootstrap', '1.4.2', BOOT_DIGEST, true);
    await half('cdk-synth', '1.4.2', SYNTH_DIGEST, true);
    await half('cdk-synth', '1.0.0', `sha256:${'d'.repeat(64)}`, true);
    await buildImageOnly('1.4.2');
    expect(await purgeable()).toEqual(['cdk-synth@1.0.0']);
    await pg.exec('DELETE FROM pipeline_step_manifests');
    expect(await purgeable()).toEqual(['cdk-synth@1.0.0', 'cdk-synth@1.4.2', 'pipeline-bootstrap@1.4.2']);
  });

  it('a declared synth half holds the bootstrap half as well', async () => {
    await pg.query(
      `INSERT INTO pipeline_plugin_resolution (org_id, pipeline_id, stage_name, step_name, plugin_name, resolved_version, resolved_digest)
       VALUES ($1, $2, 'synth', 'synth', 'cdk-synth', '1.4.2', $3)`,
      [ORG, pipelineId, SYNTH_DIGEST],
    );
    const refs = await findVersionReferences({ pluginName: 'pipeline-bootstrap', pluginVersion: '1.4.2', imageDigest: BOOT_DIGEST, ownerOrgId: SYSTEM_ORG }, elevated);
    expect(refs.map((r) => [r.source, r.steps])).toEqual([['declared', ['synth']]]);
  });
});
