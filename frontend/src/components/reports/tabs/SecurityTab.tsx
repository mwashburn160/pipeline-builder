// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo } from 'react';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import { StatCard } from '@/components/ui/StatCard';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import { FEATURE_METADATA } from '@/lib/feature-flags';
import { useFetch } from '@/hooks/useFetch';
import type { ComplianceTrendReport, VulnerabilityExposureReport } from '@/lib/api/domains/reporting-security';
import { ExportCSVButton, ReportEmpty, SectionCardSkeleton, SectionHeading, StatCardSkeleton, fmtDate } from '../ReportHelpers';
import { useReportBucketing, type SharedFilters, type TabDataStatus } from '../useReportData';

interface SecurityTabProps {
  filters: SharedFilters;
  /** Whether `advanced_reporting` is entitled — non-entitled renders the upsell and fetches nothing. */
  enabled: boolean;
  onStatus: (status: TabDataStatus) => void;
}

/** A duration in seconds as the largest sensible unit. */
export function fmtSeconds(s: number | null): string {
  if (s === null) return '—';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** The bucket label without the midnight time part. */
const periodLabel = (p: string) => p.replace(/ 00:00:00$/, '');

/**
 * The locked state, matching the DORA upsell: same lock, same CTA, same billing
 * highlight. Nothing behind it is real data.
 */
export function SecurityUpsell() {
  const meta = FEATURE_METADATA.advanced_reporting;
  return (
    <div>
      <SectionHeading>Security and compliance</SectionHeading>
      <div className="relative overflow-hidden rounded-lg border border-default">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 blur-[3px] opacity-60 select-none pointer-events-none" aria-hidden="true">
          {['Open critical', 'Known exploited', 'Median time to fix', 'Blocked checks'].map((label) => (
            <StatCard key={label} variant="detailed" label={label} value="—" />
          ))}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface/70 backdrop-blur-[1px] px-6 py-8 text-center">
          <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-info-bg text-brand">
            <Lock className="w-5 h-5" aria-hidden="true" />
          </span>
          <h4 className="text-base font-semibold text-fg">{meta.label} &mdash; security reports</h4>
          <p className="max-w-md text-sm text-fg-muted">
            Track open vulnerabilities by severity, known-exploited findings, time to fix, expiring risk
            acceptances, and the compliance verdict trend. {meta.description}.
          </p>
          <LinkButton href="/dashboard/usage?tab=billing&highlight=advanced_reporting" size="sm" className="mt-1">
            Unlock Advanced Reporting
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

/** Vulnerability exposure and time to fix. */
export function VulnerabilityPanel({ loading, data }: { loading: boolean; data: VulnerabilityExposureReport | null }) {
  if (loading && !data) return <><StatCardSkeleton count={4} /><SectionCardSkeleton /></>;
  if (!data) return <ReportEmpty text="No vulnerability data yet" />;
  const { open, scanners, timeToFix, trend, totals, expiringAcceptances } = data;
  const nothing = open.exposures === 0 && scanners.reports === 0 && totals.new === 0 && totals.fixed === 0
    && expiringAcceptances.count === 0;
  const severityRows = [
    { source: 'Plugin images (open)', critical: open.critical, high: open.high, medium: open.medium, low: open.low, kev: open.kev },
    { source: 'Pipeline scanners (latest)', critical: scanners.critical, high: scanners.high, medium: scanners.medium, low: scanners.low, kev: scanners.kev },
  ];
  return (
    <section aria-label="Vulnerability exposure and time to fix">
      <div className="flex items-center justify-between">
        <SectionHeading>Vulnerability exposure and time to fix</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={severityRows} filename="vulnerability-severity" />
          <ExportCSVButton data={trend.map((t) => ({ period: periodLabel(t.period), new: t.new, fixed: t.fixed }))} filename="vulnerability-new-vs-fixed" />
          <ExportCSVButton data={expiringAcceptances.items.map((i) => ({ ...i }))} filename="vulnerability-expiring-acceptances" />
        </div>
      </div>
      {nothing ? (
        <ReportEmpty text="No vulnerability findings in this range" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard variant="detailed" label="Open critical" value={open.critical} sub={`${open.high} high · ${open.pipelines} pipeline${open.pipelines === 1 ? '' : 's'}`} />
            <StatCard variant="detailed" label="Known exploited (KEV)" value={open.kev + scanners.kev} sub={`${open.kev} in plugin images · ${scanners.kev} from scanners`} />
            <StatCard variant="detailed" label="Median time to fix" value={fmtSeconds(timeToFix.medianSeconds)} sub={`p90 ${fmtSeconds(timeToFix.p90Seconds)} · n = ${timeToFix.n}`} />
            <StatCard variant="detailed" label="Acceptances expiring ≤30d" value={expiringAcceptances.count} />
          </div>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Findings by severity</caption>
              <thead><tr className="text-left text-fg-muted"><th>Source</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th><th>KEV</th></tr></thead>
              <tbody>
                {severityRows.map((r) => (
                  <tr key={r.source}><td>{r.source}</td><td>{r.critical}</td><td>{r.high}</td><td>{r.medium}</td><td>{r.low}</td><td>{r.kev}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-fg-muted">
              Plugin-image exposures are tracked at Critical and High only; their KEV count covers the itemized findings.
              Open figures are as of {fmtDate(data.asOf)}.
            </p>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="text-left font-medium text-fg">New vs fixed ({totals.new} new, {totals.fixed} fixed)</caption>
              <thead><tr className="text-left text-fg-muted"><th>Period</th><th>New</th><th>Fixed</th></tr></thead>
              <tbody>
                {trend.map((t) => <tr key={t.period}><td>{periodLabel(t.period)}</td><td>{t.new}</td><td>{t.fixed}</td></tr>)}
              </tbody>
            </table>
          </Card>
          {expiringAcceptances.items.length > 0 && (
            <Card className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left font-medium text-fg">Accepted risk expiring within 30 days</caption>
                <thead><tr className="text-left text-fg-muted"><th>Pipeline</th><th>Plugin</th><th>Version</th><th>Expires</th><th>Days left</th></tr></thead>
                <tbody>
                  {expiringAcceptances.items.map((i) => (
                    <tr key={`${i.pipelineId}:${i.plugin}:${i.version}`}>
                      <td>{i.pipelineName ?? i.pipelineId}</td><td>{i.plugin}</td><td>{i.version}</td><td>{fmtDate(i.acceptedUntil)}</td><td>{i.daysLeft}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </section>
  );
}

/** Compliance trend: verdicts per bucket, exemptions, top violated rules. */
export function CompliancePanel({ loading, data }: { loading: boolean; data: ComplianceTrendReport | null }) {
  if (loading && !data) return <SectionCardSkeleton />;
  if (!data) return <ReportEmpty text="No compliance data yet" />;
  const { trend, totals, topRules, activeExemptions } = data;
  const nothing = totals.scans === 0 && totals.exemptionsCreated === 0 && topRules.length === 0 && activeExemptions === 0;
  return (
    <section aria-label="Compliance trend">
      <div className="flex items-center justify-between">
        <SectionHeading>Compliance trend</SectionHeading>
        <div className="flex gap-1">
          <ExportCSVButton data={trend.map((t) => ({ ...t, period: periodLabel(t.period) }))} filename="compliance-trend" />
          <ExportCSVButton data={topRules.map((r) => ({ ...r }))} filename="compliance-top-rules" />
        </div>
      </div>
      {nothing ? (
        <ReportEmpty text="No compliance scans or checks in this range" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard variant="detailed" label="Passed" value={totals.pass} sub={`${totals.scans} completed scan${totals.scans === 1 ? '' : 's'}`} />
            <StatCard variant="detailed" label="Warnings" value={totals.warn} />
            <StatCard variant="detailed" label="Blocked checks" value={totals.block} />
            <StatCard variant="detailed" label="Active exemptions" value={activeExemptions} sub={`${totals.exemptionsCreated} requested in range`} />
          </div>
          <Card className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Compliance verdicts and exemptions per period</caption>
              <thead><tr className="text-left text-fg-muted"><th>Period</th><th>Pass</th><th>Warn</th><th>Block</th><th>Exemptions created</th><th>Exemptions active</th></tr></thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.period}><td>{periodLabel(t.period)}</td><td>{t.pass}</td><td>{t.warn}</td><td>{t.block}</td><td>{t.exemptionsCreated}</td><td>{t.exemptionsActive}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="mt-4 overflow-x-auto">
            {topRules.length === 0 ? <ReportEmpty text="No rule violations in this range" /> : (
              <table className="w-full text-sm">
                <caption className="text-left font-medium text-fg">Top rules by violations</caption>
                <thead><tr className="text-left text-fg-muted"><th>Rule</th><th>Severity</th><th>Violations</th><th>Pipelines / plugins</th></tr></thead>
                <tbody>
                  {topRules.map((r) => <tr key={r.ruleId}><td>{r.ruleName}</td><td>{r.severity ?? '—'}</td><td>{r.violations}</td><td>{r.entities}</td></tr>)}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

/**
 * Security top-tab (`advanced_reporting`). Reads the two /reports/security
 * routes in the org's reporting timezone and week start — the same bucketing
 * the `vulnerability_exposure` and `compliance_trend` report sections use, so a
 * report and this tab agree for the same range. Non-entitled → the upsell, and
 * NO fetch fires.
 */
export function SecurityTab({ filters, enabled, onStatus }: SecurityTabProps) {
  const bucketing = useReportBucketing();
  const params = useMemo(() => ({
    ...(filters.dateFrom ? { from: filters.dateFrom } : {}),
    ...(filters.dateTo ? { to: filters.dateTo } : {}),
    ...(filters.includeDescendants ? { includeDescendants: true } : {}),
    interval: filters.interval,
    tz: bucketing.tz,
    ...(bucketing.weekStart ? { weekStart: bucketing.weekStart } : {}),
  }), [filters.dateFrom, filters.dateTo, filters.includeDescendants, filters.interval, bucketing.tz, bucketing.weekStart]);
  const key = JSON.stringify(params);
  const active = enabled && bucketing.ready;

  const vulns = useFetch(
    (signal) => (active ? api.getVulnerabilityExposure(params, { signal }) : Promise.resolve(null)), [active, key],
  );
  const compliance = useFetch(
    (signal) => (active ? api.getComplianceTrend(params, { signal }) : Promise.resolve(null)), [active, key],
  );

  const loading = enabled && (!bucketing.ready || vulns.loading || compliance.loading);
  const failed = vulns.error ?? compliance.error;
  const error = failed ? formatError(failed, 'Failed to load security reports') : null;
  const { refetch: rv } = vulns;
  const { refetch: rc } = compliance;
  useEffect(() => {
    onStatus({ loading, error, refetch: () => { void rv(); void rc(); } });
  }, [loading, error, rv, rc, onStatus]);

  if (!enabled) return <SecurityUpsell />;
  return (
    <div className="space-y-8">
      <VulnerabilityPanel loading={loading} data={vulns.data} />
      <CompliancePanel loading={loading} data={compliance.data} />
    </div>
  );
}
