// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DTOs that cross the wire are declared TWICE — once server-side, once here —
 * and nothing was keeping the two copies in step.
 *
 * Why two copies exist at all, and why most of them have to: `frontend` depends
 * on `@pipeline-builder/api-core` and `@pipeline-builder/pipeline-core`, and
 * nothing else. A response shape defined in `platform/`, `api/*`,
 * `packages/pipeline-data` or `packages/ai-core` is simply not importable from
 * the client, so the client re-declares it. That is a dependency boundary doing
 * its job, not sloppiness — those packages pull express, drizzle and redis, and
 * a value import of any of them breaks `next build`.
 *
 * What was missing is the consequence: two independent declarations of one wire
 * shape type-check happily while disagreeing. Add a field server-side, forget
 * the client copy, and TypeScript is satisfied on both sides — the mismatch
 * surfaces at runtime as `undefined`, in a browser, with no compile error
 * anywhere. That is the failure this test exists to make impossible.
 *
 * It is COMPUTED, not listed: every name declared on both sides whose body is
 * structurally identical must appear in REGISTERED. So a new copied DTO fails
 * this test until somebody classifies it, and an existing one fails the moment
 * the two bodies stop matching. Five duplicates that WERE importable (their
 * server side lives in api-core) have been collapsed to `export type … from
 * '@pipeline-builder/api-core'` instead of appearing here — that is the right
 * fix whenever the dependency boundary allows it.
 *
 * Comments and formatting are ignored; field names, types and optionality are
 * not. Names that merely COLLIDE across the boundary with different shapes
 * (`Pipeline`, `Message`, `Dashboard`, … — a DB row vs an API projection) are
 * not duplicates and are deliberately invisible here.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from '@jest/globals';

const ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['api', 'frontend', 'packages', 'platform'];

/** Wire shapes declared on BOTH sides, kept identical by this test. */
const REGISTERED: ReadonlyArray<readonly [string, string, string]> = [
  ['Alert', 'frontend/src/types/observability.ts', 'platform/src/observability/alertmanager-client.ts'],
  ['ApproverCount', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/platform-reads.ts'],
  ['AskSource', 'frontend/src/lib/api/domains/ask.ts', 'packages/ai-core/src/ask-agent.ts'],
  ['AuditChainBreak', 'frontend/src/types/audit.ts', 'platform/src/helpers/audit-chain.ts'],
  ['BlockedInfo', 'frontend/src/types/plugin-installs.ts', 'api/plugin/src/services/ecosystem/installs-views.ts'],
  ['BuildHealth', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['BuildHealthStage', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['ComposedSection', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['DashboardWithPanels', 'frontend/src/types/observability.ts', 'platform/src/services/dashboard-service.ts'],
  ['DataQualityNote', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['DoraLevel', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['ImpersonationPolicy', 'frontend/src/lib/api/domains/organizations.ts', 'platform/src/helpers/impersonation-policy.ts'],
  ['IncidentListItem', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['IncidentTestResult', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['InvitationDelivery', 'frontend/src/types/organization.ts', 'platform/src/services/invitation-service.ts'],
  ['OrgIdpConfigDto', 'frontend/src/types/sso.ts', 'platform/src/services/org-idp-service.ts'],
  ['ParsedIdpMetadata', 'frontend/src/types/sso.ts', 'platform/src/services/saml-service.ts'],
  ['PluginIcon', 'frontend/src/types/plugin.ts', 'packages/pipeline-data/src/database/schema/plugin.ts'],
  ['RangeKey', 'frontend/src/types/observability.ts', 'platform/src/observability/catalog.ts'],
  ['ReportSnapshot', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['Scope', 'frontend/src/lib/templates.ts', 'packages/pipeline-core/src/template/evaluator.ts'],
  ['SeatUsage', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  ['Silence', 'frontend/src/types/observability.ts', 'platform/src/observability/alertmanager-client.ts'],
  ['SimilarPlugin', 'frontend/src/types/plugin.ts', 'api/plugin/src/helpers/similar-plugins.ts'],
  ['SsoTestReport', 'frontend/src/types/sso.ts', 'platform/src/helpers/sso-test-flow.ts'],
  ['TeamUsageRow', 'frontend/src/lib/api/domains/billing.ts', 'api/billing/src/helpers/team-usage.ts'],
  ['TotpEnrolment', 'frontend/src/types/identity.ts', 'platform/src/services/totp-service.ts'],
  ['TrendDirection', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['UsageEntry', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  ['UsageRollup', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  ['VerifiedCheck', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
  ['VerifiedCheckId', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
  ['VerifiedEligibility', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
];

function sources(): string[] {
  const out: string[] = [];
  // `lib` cannot be excluded by NAME: `packages/*/lib` is compiled output, but
  // `frontend/src/lib` is source and holds a third of the shapes this test is
  // about. Excluding the name silently dropped them and the corpus guard below
  // is what caught it. So the filter is on the PATH: only a package's `src`
  // tree, plus the frontend's pages-router directory.
  // NOTE the shapes differ: services are `api/<name>/src/` and packages are
  // `packages/<name>/src/`, but platform is `platform/src/` — one level
  // shallower. A single `(api|packages|platform)/[^/]+/src/` silently dropped
  // every platform-sourced pair, which is 13 of them.
  const KEEP = /^(?:(?:api|packages)\/[^/]+\/src\/|platform\/src\/|frontend\/(?:src|pages)\/)/;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'generated' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'test') walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name) || /\.d\.ts$/.test(e.name)) continue;
      const rel = p.slice(ROOT.length + 1);
      if (KEEP.test(rel)) out.push(rel);
    }
  };
  for (const r of ROOTS) { const p = join(ROOT, r); if (statSync(p).isDirectory()) walk(p); }
  return out;
}

/** The declaration text of `name` in `rel`, or null. Braces are matched, not regexed. */
function declarationOf(rel: string, name: string): string | null {
  const t = readFileSync(join(ROOT, rel), 'utf-8');
  const m = new RegExp(`export (?:interface|type) ${name}\\b`).exec(t);
  if (!m) return null;
  const seg = t.slice(m.index);
  if (seg.startsWith('export interface')) {
    const i = seg.indexOf('{');
    let depth = 0;
    for (let j = i; j < seg.length; j++) {
      if (seg[j] === '{') depth++;
      else if (seg[j] === '}' && --depth === 0) return seg.slice(0, j + 1);
    }
    return null;
  }
  const e = seg.indexOf(';');
  return e > 0 ? seg.slice(0, e + 1) : null;
}

/** Structure only: comments and whitespace are noise, field names and types are not. */
const shape = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/[\s;,]+/g, ' ').trim();

const isClient = (rel: string) => rel.startsWith('frontend/');

describe('wire types declared on both sides of the client boundary', () => {
  const files = sources();
  const declared = new Map<string, string[]>();
  for (const f of files) {
    const t = readFileSync(join(ROOT, f), 'utf-8');
    for (const m of t.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_]\w*)/gm)) {
      const k = m[1]!;
      if (!declared.has(k)) declared.set(k, []);
      declared.get(k)!.push(f);
    }
  }

  /** Every name declared on both sides whose bodies are structurally identical. */
  const duplicated: Array<[string, string, string]> = [];
  for (const [name, where] of declared) {
    const fe = where.filter(isClient);
    const sv = where.filter((f) => !isClient(f));
    if (!fe.length || !sv.length) continue;
    const a = declarationOf(fe[0]!, name);
    const b = declarationOf(sv[0]!, name);
    if (a && b && shape(a) === shape(b)) duplicated.push([name, fe[0]!, sv[0]!]);
  }

  it('discovers the corpus (guards a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(declared.size).toBeGreaterThan(500);
    expect(duplicated.length).toBeGreaterThan(20);
  });

  it('keeps every registered pair structurally identical', () => {
    const drifted: string[] = [];
    for (const [name, fe, sv] of REGISTERED) {
      const a = declarationOf(fe, name);
      const b = declarationOf(sv, name);
      if (!a || !b) { drifted.push(`${name}: declaration missing (${!a ? fe : sv})`); continue; }
      if (shape(a) !== shape(b)) drifted.push(`${name}: ${fe} no longer matches ${sv}`);
    }
    expect({
      drifted,
      fix: 'A wire shape now differs between the server and the client. Both sides type-check '
        + 'in isolation, so nothing else will catch it — the mismatch shows up at runtime as an '
        + 'undefined field in the browser. Update the other copy, or collapse both to an '
        + '`export type … from \'@pipeline-builder/api-core\'` if the server side is importable.',
    }).toEqual({ drifted: [], fix: expect.any(String) });
  });

  it('leaves no copied wire shape unregistered', () => {
    const known = new Set(REGISTERED.map(([n]) => n));
    const unregistered = duplicated.map(([n, fe, sv]) => `${n} (${fe} <-> ${sv})`).filter((s) => !known.has(s.split(' ')[0]!));
    expect({
      unregistered,
      fix: 'This shape is now declared identically on both sides of the client boundary with '
        + 'nothing keeping the copies in step. Prefer deleting the client copy for an '
        + '`export type … from \'@pipeline-builder/api-core\'` — possible whenever the server '
        + 'side already lives in api-core or pipeline-core, the only two packages the frontend '
        + 'depends on. If it lives in platform/, api/* or pipeline-data the client cannot import '
        + 'it, so add it to REGISTERED instead.',
    }).toEqual({ unregistered: [], fix: expect.any(String) });
  });

  it('carries no stale registration', () => {
    const live = new Set(duplicated.map(([n]) => n));
    // A pair that stopped being a duplicate (collapsed to a re-export, or
    // deliberately diverged) must not keep a carve-out that would later excuse
    // a genuine copy of the same name.
    expect(REGISTERED.filter(([n]) => !live.has(n)).map(([n]) => n)).toEqual([]);
  });
});
