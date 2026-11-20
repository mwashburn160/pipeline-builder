// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The nightly CVE remediation vocabulary is spelled twice: once as api-core
 * catalogs (what the services write and validate against) and once as the
 * CHECK constraints / partial-index predicates in postgres-init.sql (and the
 * Drizzle mirror). This guard reads the INSTALLED constraints and indexes back
 * from real SQL (PGlite) and pins each list to its catalog, so a value added
 * to one side only fails here instead of as a runtime CHECK violation.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  ACTIVE_BUILD_REMEDIATION_STAGES,
  LIBRARY_UPGRADE_LEVELS,
  LIVE_REMEDIATION_STAGES,
  PIPELINE_REMEDIATION_ELECTIONS,
  PIPELINE_REMEDIATION_UPGRADE_STATES,
  PLUGIN_REMEDIATION_KINDS,
  PLUGIN_REMEDIATION_MODES,
  PLUGIN_REMEDIATION_OUTCOMES,
  PLUGIN_REMEDIATION_STAGES,
  PLUGIN_SOURCE_KINDS,
  PLUGIN_SOURCE_ORPHAN_KINDS,
  TEAM_REMEDIATION_ROLLOUTS,
} from '@pipeline-builder/api-core';
import { bootTenantDb, type TenantTestDb } from '../src/testing/index.js';

let tdb: TenantTestDb;

beforeAll(async () => {
  tdb = await bootTenantDb();
}, 120_000);
afterAll(async () => { await tdb?.close(); });

/** Every quoted literal in a constraint / index definition, sorted. */
const literals = (def: string): string[] => [...def.matchAll(/'([^']*)'/g)].map((m) => m[1]!).sort();
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

async function checkDef(table: string, name: string): Promise<string> {
  const r = await tdb.asOwner((q) => q.query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2', [table, name]));
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.def;
}

async function indexDef(name: string): Promise<string> {
  const r = await tdb.asOwner((q) => q.query<{ def: string }>('SELECT indexdef AS def FROM pg_indexes WHERE indexname = $1', [name]));
  expect(r.rows).toHaveLength(1);
  return r.rows[0]!.def;
}

describe('postgres-init.sql vocabularies match the api-core catalogs', () => {
  it.each([
    ['plugin_remediations', 'plugin_remediation_stage_check', PLUGIN_REMEDIATION_STAGES],
    ['plugin_remediations', 'plugin_remediation_outcome_check', PLUGIN_REMEDIATION_OUTCOMES],
    ['plugin_remediations', 'plugin_remediation_kind_check', PLUGIN_REMEDIATION_KINDS],
    ['plugin_remediations', 'plugin_remediation_upgrade_level_check', LIBRARY_UPGRADE_LEVELS],
    ['plugin_remediations', 'plugin_remediation_publish_mode_check', PLUGIN_REMEDIATION_MODES.filter((m) => m !== 'off')],
    ['plugin_source_orphans', 'plugin_source_orphan_kind_check', PLUGIN_SOURCE_ORPHAN_KINDS],
    ['plugin_remediation_settings', 'plugin_remediation_settings_mode_check', PLUGIN_REMEDIATION_MODES],
    ['plugin_remediation_settings', 'plugin_remediation_settings_level_check', LIBRARY_UPGRADE_LEVELS],
    ['plugin_remediation_settings', 'plugin_remediation_settings_rollout_check', TEAM_REMEDIATION_ROLLOUTS],
    ['pipeline_remediation_upgrades', 'pipeline_remediation_upgrade_mode_check', PLUGIN_REMEDIATION_MODES],
    ['pipeline_remediation_upgrades', 'pipeline_remediation_upgrade_state_check', PIPELINE_REMEDIATION_UPGRADE_STATES],
    ['pipelines', 'pipeline_remediation_upgrades_check', PIPELINE_REMEDIATION_ELECTIONS],
    ['plugins', 'plugin_source_kind_check', PLUGIN_SOURCE_KINDS],
    ['plugin_listing_versions', 'plugin_listing_versions_source_kind_check', PLUGIN_SOURCE_KINDS],
  ] as const)('%s.%s', async (table, name, catalog) => {
    expect(literals(await checkDef(table, name))).toEqual(sorted(catalog));
  });

  it('the idempotency indexes cover exactly the live / active-build stages', async () => {
    expect(literals(await indexDef('plugin_remediation_live_unique'))).toEqual(sorted(LIVE_REMEDIATION_STAGES));
    expect(literals(await indexDef('plugin_remediation_active_version_unique'))).toEqual(sorted(ACTIVE_BUILD_REMEDIATION_STAGES));
  });
});
