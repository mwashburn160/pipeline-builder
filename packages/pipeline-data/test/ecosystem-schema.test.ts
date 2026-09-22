// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the plugin-ecosystem database contract at BOTH layers it is declared:
 * the drizzle schema (what services query with) and the shipped
 * `postgres-init.sql` (what actually exists). Column sets and index names must
 * agree, the org-scoped / ecosystem-global split must match the RLS blocks, and
 * the anonymous `ecosystem_public_reader` role must be able to read the two
 * `public_*` views and nothing else.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getTableConfig, getViewConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as eco from '../src/database/schema/ecosystem.js';
import { pipelineEvent } from '../src/database/schema/pipeline.js';
import { plugin } from '../src/database/schema/plugin.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DDL = readFileSync(resolve(REPO_ROOT, 'deploy/shared/postgres-init.sql'), 'utf8');

/** The `CREATE TABLE <name> (...)` body, so a column can't be found in an unrelated table. */
function tableBody(name: string): string {
  const start = DDL.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  // Some tables open with the first column on the CREATE line; normalize it
  // onto its own line so every column declaration looks alike.
  return DDL.slice(start).split(');')[0].replace(/\(\s{4}(?=[a-z])/, '(\n    ');
}

/** Column names declared in the DDL: the CREATE TABLE body plus any `ADD COLUMN`s. */
function ddlColumns(name: string): string[] {
  const cols = [...tableBody(name).matchAll(/^ {4}([a-z][a-z0-9_]*) [A-Z]/gm)].map((m) => m[1]);
  const added = new RegExp(`ALTER TABLE ${name}\\s+ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)`, 'g');
  return [...cols, ...[...DDL.matchAll(added)].map((m) => m[1])].sort();
}

/** The body of a `-- … FOREACH/unnest ARRAY[...]` table list following `marker`. */
function arrayAfter(marker: string): string[] {
  const at = DDL.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const list = DDL.slice(at).match(/ARRAY\[([\s\S]*?)\]/)![1];
  return [...list.replace(/--.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const ECO_TABLES: PgTable[] = [
  eco.publisher, eco.pluginListing, eco.pluginListingVersion, eco.pluginAdvisory, eco.ecosystemAutoApprovalRule,
  eco.pluginPublishRequest, eco.ecosystemReservedName, eco.ecosystemSetting, eco.ecosystemCollection,
  eco.pluginReview, eco.pluginReviewReply, eco.pluginReviewReport, eco.pluginReviewVote, eco.pluginReviewHistory,
  eco.pluginStats, eco.pluginSubmission, eco.ecosystemSearchMiss, eco.ecosystemNotificationQueue,
  eco.pipelineStepManifest, eco.pluginInstall, eco.pluginInstallPolicy, eco.pluginAdvisoryDelivery,
];

const ORG_SCOPED = ['pipeline_step_manifests', 'plugin_installs', 'plugin_install_policies', 'plugin_advisory_deliveries'];

describe('ecosystem schema matches the shipped DDL', () => {
  it.each(ECO_TABLES.map((t) => [getTableConfig(t).name, t] as const))(
    '%s: same columns, indexes and foreign keys in drizzle and SQL', (name, table) => {
      const config = getTableConfig(table);
      expect(config.columns.map((c) => c.name).sort()).toEqual(ddlColumns(name));
      for (const col of config.columns) {
        // Resolves custom types (tsvector) too.
        expect(col.getSQLType()).toBeTruthy();
      }
      for (const idx of config.indexes) {
        expect(DDL).toContain(`INDEX IF NOT EXISTS ${idx.config.name}\n    ON ${name}`);
      }
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const target = getTableConfig(ref.foreignTable).name;
        expect(tableBody(name)).toMatch(new RegExp(`${ref.columns[0].name} UUID[^,]*REFERENCES ${target}\\(id\\)`));
      }
      for (const chk of config.checks) {
        expect(chk.value).toBeDefined();
      }
    });

  it('plugins carries the ecosystem columns and a lifecycle that admits yanked', () => {
    expect(getTableConfig(plugin).columns.map((c) => c.name).sort()).toEqual(ddlColumns('plugins'));
    expect(tableBody('plugins')).toContain(
      "CHECK (lifecycle IN ('experimental', 'production', 'deprecated', 'yanked'))",
    );
    const breaking = getTableConfig(plugin).columns.find((c) => c.name === 'breaking')!;
    expect(breaking.notNull).toBe(true);
    expect(breaking.default).toBe(false);
  });

  it('pipeline_events carries the per-plugin telemetry columns + reporting index', () => {
    const { columns, indexes } = getTableConfig(pipelineEvent);
    expect(columns.map((c) => c.name).sort()).toEqual(ddlColumns('pipeline_events'));
    const idx = indexes.find((i) => i.config.name === 'event_plugin_idx')!;
    expect(idx.config.where).toBeDefined();
    expect(DDL).toContain('event_plugin_idx\n    ON pipeline_events(plugin_publisher, plugin_name, plugin_version, completed_at)');
  });

  it('listing search: trigger-maintained weighted vector, GIN + trigram indexes', () => {
    const { indexes } = getTableConfig(eco.pluginListing);
    expect(indexes.find((i) => i.config.name === 'plugin_listing_search_vector_idx')!.config.method).toBe('gin');
    expect(indexes.find((i) => i.config.name === 'plugin_listing_name_trgm_idx')!.config.method).toBe('gin');
    expect(DDL).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    expect(DDL).toContain('ON plugin_listings USING gin (name gin_trgm_ops)');
    expect(DDL).toMatch(/BEFORE INSERT OR UPDATE ON plugin_listings\s+FOR EACH ROW\s+EXECUTE PROCEDURE plugin_listings_search_vector_update\(\)/);
    for (const w of ["NEW.name, '')), 'A'", "), 'B')", "NEW.summary, '')), 'C'", "), 'D')"]) {
      expect(DDL).toContain(w);
    }
  });

  it('at most one OPEN publish request per (publisher, kind, listing|name, version)', () => {
    const idx = getTableConfig(eco.pluginPublishRequest).indexes
      .find((i) => i.config.name === 'plugin_publish_request_open_unique')!;
    expect(idx.config.unique).toBe(true);
    expect(DDL).toMatch(/plugin_publish_request_open_unique[\s\S]*?WHERE status IN \('pending', 'pending_second_approval'\) AND kind <> 'advisory';/);
    expect([...eco.OPEN_PUBLISH_REQUEST_STATUSES]).toEqual(['pending', 'pending_second_approval']);
  });
});

describe('ecosystem RLS split', () => {
  const orgScopedLoop = arrayAfter('SELECT unnest(ARRAY[');
  const globalLoop = arrayAfter('Plugin ecosystem, GLOBAL half');

  it('tables with org_id are exactly the org-scoped set, and get the rls_org_* policies + FORCE', () => {
    const withOrgId = ECO_TABLES
      .filter((t) => getTableConfig(t).columns.some((c) => c.name === 'org_id'))
      .map((t) => getTableConfig(t).name);
    expect(withOrgId.sort()).toEqual([...ORG_SCOPED].sort());
    for (const t of ORG_SCOPED) {
      expect(orgScopedLoop).toContain(t);
      expect(DDL).toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`);
    }
  });

  it('every ecosystem-global table gets the app-role-only policy and is not FORCEd', () => {
    const global = ECO_TABLES.map((t) => getTableConfig(t).name).filter((n) => !ORG_SCOPED.includes(n));
    expect([...globalLoop].sort()).toEqual(global.sort());
    for (const t of global) {
      expect(orgScopedLoop).not.toContain(t);
      expect(DDL).not.toContain(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    }
    expect(DDL).toContain("'CREATE POLICY rls_ecosystem_app ON %I AS PERMISSIVE FOR ALL TO %I '");
  });
});

describe('ecosystem_public_reader can read the public views and nothing else', () => {
  const READER = 'ecosystem_public_reader';
  const VIEWS = ['public_listings', 'public_listed_versions', 'public_advisories', 'public_reviews'];
  /** Every `GRANT <privs> ON <objects> TO ecosystem_public_reader` in the file. */
  const grants = [...DDL.matchAll(new RegExp(`\\bGRANT ([^\\n;']+?) ON ([^\\n;']+?) TO ${READER}\\b`, 'g'))]
    .map((m) => ({ privs: m[1].trim(), on: m[2].trim() }));

  it('grants SELECT on exactly the public views, plus CONNECT + schema USAGE', () => {
    expect(grants).toEqual([
      { privs: 'CONNECT', on: 'DATABASE %I' },
      { privs: 'USAGE', on: 'SCHEMA public' },
      { privs: 'SELECT', on: VIEWS.join(', ') },
    ]);
  });

  it('starts every run from zero table/sequence privileges', () => {
    const revokeAt = DDL.indexOf(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${READER};`);
    expect(revokeAt).toBeGreaterThan(0);
    expect(DDL).toContain(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${READER};`);
    expect(revokeAt).toBeLessThan(DDL.indexOf(`GRANT SELECT ON ${VIEWS.join(', ')} TO ${READER}`));
  });

  it('never reaches it through default privileges or PUBLIC', () => {
    // Statements only: comments may mention default privileges in prose.
    const code = DDL.replace(/^\s*--.*$/gm, '');
    const defaults = [...code.matchAll(/ALTER DEFAULT PRIVILEGES[^\n]*/g)].map((m) => m[0]);
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      expect(d).not.toContain(READER);
      expect(d).not.toMatch(/TO PUBLIC/i);
      // The only default-privilege grantee is the application role.
      expect(d).toMatch(/TO %I', current_user, app_user\);$/);
    }
    expect(code).not.toMatch(/\bGRANT [^\n;]*\bTO PUBLIC\b/i);
  });

  it('is a locked-down login role created only when its password is supplied', () => {
    expect(DDL).toContain('\\getenv pb_reader_password ECOSYSTEM_PUBLIC_READER_PASSWORD');
    expect(DDL).toMatch(/RAISE NOTICE 'postgres-init: ECOSYSTEM_PUBLIC_READER_PASSWORD is unset/);
    for (const verb of ['CREATE ROLE', 'ALTER ROLE']) {
      expect(DDL).toContain(`${verb} ${READER} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L`);
    }
  });

  describe.each([
    ['public_listings', eco.publicListings],
    ['public_listed_versions', eco.publicListedVersions],
    ['public_advisories', eco.publicAdvisories],
    ['public_reviews', eco.publicReviews],
  ] as const)('%s', (name, view) => {
    const header = `CREATE OR REPLACE VIEW ${name} WITH (security_barrier = true) AS`;
    const body = DDL.slice(DDL.indexOf(header)).split(';')[0];
    /** Output column names: the alias, else the bare column after `x.`. */
    const outputs = body.slice(body.indexOf('SELECT') + 6, body.indexOf('\nFROM'))
      .replace(/--.*$/gm, '')
      .split(/,\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.match(/\bAS ([a-z_0-9]+)$/)?.[1] ?? item.split('.').pop()!);

    it('runs with owner rights behind a security barrier (not security_invoker)', () => {
      expect(DDL).toContain(header);
      expect(body).not.toMatch(/security_invoker/);
    });

    it('projects an explicit column list with no tenant or user identifiers', () => {
      expect(body).not.toMatch(/SELECT\s+\*/);
      expect(body).not.toMatch(/\.\*/);
      for (const forbidden of [
        'org_id', 'owner_org_id', 'author_org_id', 'submitted_org_id', 'created_by', 'published_by',
        'source_plugin_id', 'env', 'build_args', 'commands', 'install_commands', 'dockerfile', 'spec_snapshot',
      ]) {
        expect(outputs).not.toContain(forbidden);
      }
    });

    it('matches the drizzle view declaration column-for-column', () => {
      const cfg = getViewConfig(view);
      expect(cfg.isExisting).toBe(true);
      expect(Object.values(cfg.selectedFields).map((c) => (c as { name: string }).name)).toEqual(outputs);
    });
  });

  it('filters to listed listings of non-suspended publishers (and non-paused versions)', () => {
    // Unmaintained listings stay public (banner); suspended/transferred don't.
    expect(DDL).toMatch(/WHERE l\.state IN \('listed', 'unmaintained'\)\s+AND p\.suspended_at IS NULL;/);
    expect(DDL).not.toMatch(/l\.state = 'listed'/);
    // Paused versions are hidden. Yanked ones stay visible, FLAGGED, so the
    // directory can mark them; nothing resolves through the view.
    expect(DDL).toMatch(/AND p\.suspended_at IS NULL\s+AND v\.paused_at IS NULL;/);
    expect(DDL).not.toMatch(/AND v\.yanked_at IS NULL/);
    expect(DDL).toContain('(v.yanked_at IS NOT NULL) AS yanked');
    // Only PUBLISHED advisories are public.
    expect(DDL).toMatch(/WHERE a\.state = 'published'\s+AND l\.state IN \('listed', 'unmaintained'\)\s+AND p\.suspended_at IS NULL;/);
    // Only PUBLISHED reviews of public, non-paused listings; no author ids.
    expect(DDL).toMatch(/WHERE r\.status = 'published'\s+AND l\.state IN \('listed', 'unmaintained'\)\s+AND l\.paused_at IS NULL\s+AND p\.suspended_at IS NULL;/);
    // Active-org count stays hidden below the display threshold.
    expect(DDL).toContain('CASE WHEN s.active_org_count >= 5 THEN s.active_org_count END AS active_org_count');
  });
});
