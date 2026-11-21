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
  ['ActionFailure', 'frontend/src/components/reports/types.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  // Admin billing summary, per currency (api/billing, not importable).
  ['AdminBillingSummary', 'frontend/src/lib/api/domains/billing.ts', 'api/billing/src/helpers/billing-ledger.ts'],
  ['Alert', 'frontend/src/types/observability.ts', 'api/ops-center/src/observability/alertmanager-client.ts'],
  // Plugin-upgrade apply's per-step change (api/pipeline, not importable).
  ['AppliedUpgrade', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/pipeline/src/helpers/plugin-upgrades.ts'],
  ['ApproverCount', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/platform-reads.ts'],
  ['AskSource', 'frontend/src/lib/api/domains/ask.ts', 'packages/ai-core/src/ask-agent.ts'],
  ['AuditChainBreak', 'frontend/src/types/audit.ts', 'platform/src/helpers/audit-chain.ts'],
  ['BlockedInfo', 'frontend/src/types/plugin-installs.ts', 'api/plugin/src/services/ecosystem/installs-views.ts'],
  ['BuildHealth', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['BuildHealthStage', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  // Team benchmarking's row shapes (pipeline-data, not importable).
  ['BenchmarkCell', 'frontend/src/lib/api/domains/reporting-benchmark.ts', 'packages/pipeline-data/src/api/reporting/team-benchmark.ts'],
  ['BenchmarkSuccess', 'frontend/src/lib/api/domains/reporting-benchmark.ts', 'packages/pipeline-data/src/api/reporting/team-benchmark.ts'],
  ['TeamBenchmarkRow', 'frontend/src/lib/api/domains/reporting-benchmark.ts', 'packages/pipeline-data/src/api/reporting/team-benchmark.ts'],
  // The crossover verdict. Registered rather
  // than shared because it is served by api/billing, which the client cannot
  // import — and the figures in it reach a customer, so the two shapes drifting
  // apart is a wrong price rather than a type error.
  ['CrossoverVerdict', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/crossover.ts'],
  // A published report run's delivery record (api/reporting, not importable).
  ['DeliveryOutcome', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'api/reporting/src/services/report-delivery.ts'],
  ['ErrorEntry', 'frontend/src/components/reports/types.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['StageBottleneck', 'frontend/src/components/reports/types.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['StageFailure', 'frontend/src/components/reports/types.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  // The past-due lapse window on a subscription response (api/billing, not importable).
  ['SubscriptionDunning', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/subscription-response.ts'],
  ['ComposedSection', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  // A staff reply template. The server shape lives in pipeline-data, which the
  // client cannot import, so the copy is registered rather than shared.
  ['CannedResponse', 'frontend/src/types/message.ts', 'packages/pipeline-data/src/api/support-cases.ts'],
  ['DashboardWithPanels', 'frontend/src/types/observability.ts', 'api/ops-center/src/services/dashboard-service.ts'],
  ['DataQualityNote', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  // Now that the client carries every field the server scores (deployment
  // frequency and MTTR levels, the lead-time / MTTR tails), keep them in step.
  ['DoraMetrics', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['DoraTrendPoint', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['IncidentListItem', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['IncidentTestResult', 'frontend/src/lib/api/domains/reporting.ts', 'packages/pipeline-data/src/api/reporting/types.ts'],
  ['InvitationDelivery', 'frontend/src/types/organization.ts', 'platform/src/services/invitation-service.ts'],
  // A gate-refused setup image kept for promotion (api/plugin, not importable).
  ['KeptSetupImageView', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/plugin/src/services/kept-setup-images.ts'],
  ['OrgIdpConfigDto', 'frontend/src/types/sso.ts', 'platform/src/services/org-idp-service.ts'],
  ['ParsedIdpMetadata', 'frontend/src/types/sso.ts', 'platform/src/services/saml-service.ts'],
  ['PluginIcon', 'frontend/src/types/plugin.ts', 'packages/api-core/src/types/plugin-wire.ts'],
  // A version in the fleet / moderation vulnerability attention lists (api/plugin, not importable).
  ['PostureVersion', 'frontend/src/lib/api/plugin-vulnerability-types.ts', 'api/plugin/src/services/plugin-vuln-posture.ts'],
  ['PromotionResult', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/plugin/src/services/kept-setup-images.ts'],
  ['RangeKey', 'frontend/src/types/observability.ts', 'api/ops-center/src/observability/catalog.ts'],
  ['ReportSnapshot', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['Scope', 'frontend/src/lib/templates.ts', 'packages/pipeline-core/src/template/evaluator.ts'],
  // Superseded system plugin version retention: the Retention panel's report (api/plugin, not importable).
  ['RetentionAction', 'frontend/src/types/plugin-retention.ts', 'api/plugin/src/services/retention/plan.ts'],
  ['RetentionState', 'frontend/src/types/plugin-retention.ts', 'api/plugin/src/services/retention/select.ts'],
  ['RetentionVersionEntry', 'frontend/src/types/plugin-retention.ts', 'api/plugin/src/services/retention/plan.ts'],
  // Automatic plugin version tidying: the preview's report and the org's settings (api/plugin, not importable).
  ['TidyAction', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/pass.ts'],
  ['TidyOrgReport', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/pass.ts'],
  ['TidySettings', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/settings.ts'],
  ['TidyState', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/decide.ts'],
  ['TidyTotals', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/pass.ts'],
  ['TidyVersionEntry', 'frontend/src/types/plugin-tidy.ts', 'api/plugin/src/services/tidy/pass.ts'],
  ['SeatUsage', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  // An artifact security report's counts (api/pipeline, not importable).
  ['SeverityCounts', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/pipeline/src/helpers/security-report.ts'],
  ['Silence', 'frontend/src/types/observability.ts', 'api/ops-center/src/observability/alertmanager-client.ts'],
  ['SimilarPlugin', 'frontend/src/types/plugin.ts', 'api/plugin/src/helpers/similar-plugins.ts'],
  ['SsoTestReport', 'frontend/src/types/sso.ts', 'platform/src/helpers/sso-test-flow.ts'],
  ['StepUpgrade', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/pipeline/src/helpers/plugin-upgrades.ts'],
  ['TeamUsageRow', 'frontend/src/lib/api/domains/billing.ts', 'api/billing/src/helpers/team-usage.ts'],
  // A platform-default history row's kind (the Toolchain console's History panel; pipeline-data, not importable).
  ['ToolchainDefaultKind', 'frontend/src/types/toolchain.ts', 'packages/pipeline-data/src/database/schema/toolchain.ts'],
  ['TotpEnrolment', 'frontend/src/types/identity.ts', 'platform/src/services/totp-service.ts'],
  ['TrendDirection', 'frontend/src/lib/api/domains/stakeholder-reports.ts', 'packages/pipeline-data/src/api/reporting/stakeholder/compose.ts'],
  ['UpgradeReason', 'frontend/src/lib/api/pipeline-security-types.ts', 'api/pipeline/src/helpers/plugin-upgrades.ts'],
  ['UsageEntry', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  ['UsageRollup', 'frontend/src/types/billing.ts', 'api/billing/src/helpers/usage-helpers.ts'],
  // A posture version's lifecycle state (api/plugin, not importable).
  ['VersionState', 'frontend/src/lib/api/plugin-vulnerability-types.ts', 'api/plugin/src/services/plugin-vuln-posture.ts'],
  ['VerifiedCheck', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
  ['VerifiedCheckId', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
  ['VerifiedEligibility', 'frontend/src/types/ecosystem.ts', 'api/plugin/src/services/ecosystem/verified-eligibility.ts'],
  ['ComplianceTrendPoint', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/compliance-trend.ts'],
  ['ComplianceTrendReport', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/compliance-trend.ts'],
  ['ExpiringAcceptance', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/security.ts'],
  ['TopViolatedRule', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/compliance-trend.ts'],
  ['VulnTrendPoint', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/security.ts'],
  ['VulnerabilityExposureReport', 'frontend/src/lib/api/domains/reporting-security.ts', 'packages/pipeline-data/src/api/reporting/security.ts'],
  ['ApprovalStage', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['ApprovalTrendPoint', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['ApprovalWaitReport', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['QueueAction', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['QueueByComputeType', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['QueueTrendPoint', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['QueueWaitReport', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  ['WaitStats', 'frontend/src/lib/api/domains/reporting-flow.ts', 'packages/pipeline-data/src/api/reporting/flow.ts'],
  // The AI assistant usage report (api/quota, not importable).
  ['AiCallerTypeRow', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  ['AiFeatureRow', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  ['AiTeamRow', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  ['AiUsageBucketRow', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  ['AiUsageReport', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  ['AiUsageTotals', 'frontend/src/types/ai-usage.ts', 'api/quota/src/services/ai-usage-report.ts'],
  // The Delivery tab's reports (pipeline-data, not importable).
  ['RunOutcomeCounts', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['RunRequestTrendPoint', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['RunnerFailureCode', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['RunnerReliabilityRow', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['RunnerReliabilityReport', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['CalendarDay', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['ProductionDeployOutcome', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['ProductionDeploy', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
  ['DeploymentCalendarReport', 'frontend/src/lib/api/domains/reporting-delivery.ts', 'packages/pipeline-data/src/api/reporting/delivery.ts'],
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
