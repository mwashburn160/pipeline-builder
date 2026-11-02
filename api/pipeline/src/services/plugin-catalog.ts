// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { isSystemOrgId, scanFreshness, versionScanFacts } from '@pipeline-builder/api-core';
import { OFFICIAL_PUBLISHER_HANDLE, schema, withTenantTx } from '@pipeline-builder/pipeline-data';
import { and, isNull, notInArray } from 'drizzle-orm';
import { availablePluginConditions, findResolvableListings } from './plugin-lookup-service.js';

/**
 * The plugin catalog an AI generation is offered: the org's own plugins plus the
 * marketplace listings it resolves, ranked by trust and health and narrowed to
 * the request's technology context.
 */

export interface PluginSummary {
  name: string;
  /**
   * The publisher to write on the reference (see docs/plugin-installing.md): set for a
   * listing an unqualified name wouldn't reach — any non-Official listing, or
   * an Official one the org's own plugin of the same name shadows.
   */
  publisher?: string;
  description: string | null;
  version: string;
  pluginType: string;
  computeType: string;
  commands: string[];
  installCommands: string[];
  keywords: string[];
  category: string;
  metadata: Record<string, string | number | boolean>;
  env: Record<string, string>;
  /**
   * Who stands behind it: `own` for the org's own (or
   * parent's shared) plugin, otherwise the trust tier — a system-org catalog
   * row or an Official listing is `official`.
   */
  tier?: PluginTrust;
  /** Bayesian rating (0–5) of a listing, null when unrated or not a listing. */
  ratingBayes?: number | null;
  /** 0–100 health score of a listing, null when unknown. */
  healthScore?: number | null;
  /** `paused` (publisher paused new installs) and `unmaintained` listings are offered last and flagged. */
  lifecycle?: PluginLifecycle;
  /**
   * A scan caveat: the image was never scanned, or its last scan is stale. Such
   * plugins are offered LAST and flagged. Absent = scanned recently (or
   * image-less: nothing to scan). Flagged and KEV versions are never offered.
   */
  scan?: PluginScanCaveat;
}

export type PluginTrust = 'own' | 'official' | 'verified' | 'community' | 'unverified';
export type PluginLifecycle = 'active' | 'paused' | 'unmaintained';
export type PluginScanCaveat = 'unscanned' | 'stale';

// -- Scan standing ------------------------------------------------------------

/** The scan columns a version carries (plugin row or listing version). */
export interface ScanColumns {
  buildType?: string | null;
  imageDigest?: string | null;
  scannedAt?: Date | string | null;
  scanFlaggedAt?: Date | string | null;
  scanFlag?: unknown;
  scanSummary?: unknown;
}

/**
 * Whether a version may be OFFERED to the model, and with what caveat — read
 * through api-core's scan facts / freshness, the same reading `/plugins/lookup`
 * applies, so "stale" here is `PLUGIN_SCAN_STALE_HOURS` there.
 *
 * `exclude`: the rescan flagged it, or its latest scan carries a CISA
 * known-exploited finding — the AI must never wire a NEW pipeline onto either.
 * Existing references still resolve (with a warning) through the normal lookup.
 * An image-less version (metadata-only, manual approval) has nothing to scan
 * and is clean. Pure.
 */
export function scanStanding(
  v: ScanColumns & { name: string; version: string; pluginType?: string | null },
  now: Date = new Date(),
): 'exclude' | 'clean' | PluginScanCaveat {
  const facts = versionScanFacts(v);
  if (facts.flagged || facts.kev > 0) return 'exclude';
  const fresh = scanFreshness(v, now).state;
  return fresh === 'unscanned' || fresh === 'stale' ? fresh : 'clean';
}

/** The summary field for a standing (absent when clean). */
function scanCaveat(standing: 'clean' | PluginScanCaveat): { scan?: PluginScanCaveat } {
  return standing === 'clean' ? {} : { scan: standing };
}

// -- Plugin ranking -----------------------------------------------------------

const TRUST_RANK: Record<PluginTrust, number> = { own: 0, official: 1, verified: 2, community: 3, unverified: 4 };

/**
 * Order the candidates the model sees: plugins with a scan caveat (unscanned,
 * stale scan) after every clean one; then the org's own
 * plugins, then Official, then Verified, then everyone else; within a trust
 * rung, active before paused/unmaintained, then by health score (unknown last).
 * Stable, so equal candidates keep their catalog order. Pure.
 */
export function rankPlugins<T extends Pick<PluginSummary, 'tier' | 'healthScore' | 'lifecycle' | 'scan'>>(plugins: readonly T[]): T[] {
  const caveat = (p: T) => (p.scan ? 1 : 0);
  const trust = (p: T) => (p.tier ? TRUST_RANK[p.tier] : 5);
  const winding = (p: T) => (p.lifecycle && p.lifecycle !== 'active' ? 1 : 0);
  const health = (p: T) => (typeof p.healthScore === 'number' ? p.healthScore : -1);
  return plugins
    .map((p, i) => ({ p, i }))
    .sort((a, b) => caveat(a.p) - caveat(b.p) || trust(a.p) - trust(b.p) || winding(a.p) - winding(b.p) || health(b.p) - health(a.p) || a.i - b.i)
    .map(({ p }) => p);
}

// -- Plugin context helpers ---------------------------------------------------

const UNIVERSAL_CATEGORIES = new Set(['deploy', 'infrastructure', 'notification', 'monitoring']);

const KNOWN_TECH_TERMS = [
  'nodejs', 'node', 'python', 'java', 'go', 'golang', 'ruby', 'dotnet', 'rust', 'php', 'cpp',
  'typescript', 'javascript', 'scala', 'kotlin', 'swift', 'elixir', 'dart',
  'react', 'nextjs', 'next.js', 'angular', 'vue', 'svelte', 'nuxt', 'remix', 'astro',
  'django', 'flask', 'spring', 'express', 'fastapi', 'rails', 'nestjs', 'gin', 'fiber', 'fastify',
  'docker', 'cdk', 'terraform', 'kubernetes', 'helm', 'serverless', 'lambda', 'ecs', 'fargate',
  'cloudformation', 'pulumi', 'aws', 'gcp', 'azure',
  'gradle', 'maven', 'npm', 'yarn', 'pnpm', 'cargo', 'pip', 'poetry', 'composer',
];

/** Filter plugins to those relevant for a detected project context. */
function filterPluginsByContext(plugins: PluginSummary[], terms: string[]): PluginSummary[] {
  const contextTerms = new Set(terms.map(t => t.toLowerCase()));
  if (contextTerms.size === 0) return plugins;

  const filtered = plugins.filter(p => {
    if (UNIVERSAL_CATEGORIES.has((p.category || '').toLowerCase())) return true;
    if ((p.keywords ?? []).some(k => contextTerms.has(k.toLowerCase()))) return true;
    const nameLower = p.name.toLowerCase();
    for (const term of contextTerms) {
      if (nameLower.includes(term)) return true;
    }
    return false;
  });

  return filtered.length > 0 ? filtered : plugins;
}

/**
 * The plugins the given organization can reference: its own (and its parent's
 * shared) rows, plus the LISTINGS it resolves — installed ones and the
 * implicit Official ones. An Official listing is offered by bare name
 * unless the org's own plugin shadows it; every other listing carries its
 * publisher, which the generator must write on the reference.
 */
async function getAvailablePlugins(orgId: string): Promise<PluginSummary[]> {
  const [rows, listings] = await Promise.all([getAvailablePluginRows(orgId), findResolvableListings(orgId)]);
  const ownNames = new Set(rows.map((r) => r.name));
  const listed: PluginSummary[] = listings
    // Never OFFER a deprecated, rescan-flagged or KEV version.
    .map((l) => ({ l, standing: scanStanding({ ...l.scan, name: l.name, version: l.version, pluginType: typeof l.spec.pluginType === 'string' ? l.spec.pluginType : null }) }))
    .filter(({ l, standing }) => !l.deprecated && standing !== 'exclude')
    .map(({ l, standing }) => {
      const s = l.spec;
      const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, never> : {});
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      const qualified = l.publisher !== OFFICIAL_PUBLISHER_HANDLE || ownNames.has(l.name);
      const tier: PluginTrust = (['official', 'verified', 'community', 'unverified'] as const).find((t) => t === l.tier) ?? 'unverified';
      const lifecycle: PluginLifecycle = l.paused ? 'paused' : l.unmaintained ? 'unmaintained' : 'active';
      return {
        name: l.name,
        ...(qualified ? { publisher: l.publisher } : {}),
        description: l.description,
        version: l.version,
        pluginType: typeof s.pluginType === 'string' ? s.pluginType : 'CodeBuildStep',
        computeType: typeof s.computeType === 'string' ? s.computeType : 'SMALL',
        commands: strings(s.commands),
        installCommands: strings(s.installCommands),
        keywords: l.keywords,
        category: l.category,
        metadata: record(s.metadata),
        env: record(s.env),
        tier,
        ratingBayes: l.ratingBayes,
        healthScore: l.healthScore,
        lifecycle,
        ...scanCaveat(standing as 'clean' | PluginScanCaveat),
      };
    });
  return rankPlugins([...rows, ...listed]);
}

/** The org's own (and parent's shared) active plugin rows. */
async function getAvailablePluginRows(orgId: string): Promise<PluginSummary[]> {
  // withTenantTx sets `app.org_id` — the `plugins` table is FORCE ROW LEVEL
  // SECURITY, so a bare `db.select()` runs with a null GUC and the policy drops
  // the caller org's rows (AI context would miss the org's own plugins).
  const rows = await withTenantTx(async (tx) => tx
    .select({
      orgId: schema.plugin.orgId,
      name: schema.plugin.name,
      description: schema.plugin.description,
      version: schema.plugin.version,
      pluginType: schema.plugin.pluginType,
      computeType: schema.plugin.computeType,
      commands: schema.plugin.commands,
      installCommands: schema.plugin.installCommands,
      keywords: schema.plugin.keywords,
      category: schema.plugin.category,
      metadata: schema.plugin.metadata,
      env: schema.plugin.env,
      buildType: schema.plugin.buildType,
      imageDigest: schema.plugin.imageDigest,
      scannedAt: schema.plugin.scannedAt,
      scanFlaggedAt: schema.plugin.scanFlaggedAt,
      scanFlag: schema.plugin.scanFlag,
      scanSummary: schema.plugin.scanSummary,
    })
    .from(schema.plugin)
    .where(and(
      ...availablePluginConditions(orgId),
      // Never OFFER a deprecated or yanked version: the
      // AI would wire new pipelines onto something on its way out. Existing
      // references still resolve (with a warning) through /plugins/lookup.
      isNull(schema.plugin.deprecatedAt),
      isNull(schema.plugin.yankedAt),
      notInArray(schema.plugin.lifecycle, ['deprecated', 'yanked']),
    ))) as Array<Omit<PluginSummary, 'tier'> & ScanColumns & { orgId?: string | null }>;
  // The system org's shared catalog rows are the Official plugins; the rest are
  // the org's own. Flagged / KEV versions are dropped here (a jsonb `kev` count
  // is simpler to read in code than to index), unscanned / stale ones carry the caveat.
  const now = new Date();
  return rows.flatMap(({ orgId: rowOrg, buildType, imageDigest, scannedAt, scanFlaggedAt, scanFlag, scanSummary, ...p }) => {
    const standing = scanStanding({ name: p.name, version: p.version, pluginType: p.pluginType, buildType, imageDigest, scannedAt, scanFlaggedAt, scanFlag, scanSummary }, now);
    if (standing === 'exclude') return [];
    return [{ ...p, tier: rowOrg && isSystemOrgId(rowOrg) ? 'official' as const : 'own' as const, lifecycle: 'active' as const, ...scanCaveat(standing) }];
  });
}

/**
 * Fetch plugins for an org and filter by detected context.
 * For prompt-based routes, extracts tech terms from the prompt text.
 * For URL-based routes, uses repo analysis results.
 */
export async function getFilteredPlugins(
  orgId: string,
  context: { prompt: string } | { languages: string[]; frameworks: string[]; projectType: string },
): Promise<PluginSummary[]> {
  const allPlugins = await getAvailablePlugins(orgId);

  const terms = 'prompt' in context
    ? KNOWN_TECH_TERMS.filter(t => context.prompt.toLowerCase().includes(t))
    : [...context.languages, ...context.frameworks, context.projectType].filter(Boolean);

  return terms.length > 0 ? filterPluginsByContext(allPlugins, terms) : allPlugins;
}
