// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read the `submission` block of `GET /plugins/ecosystem/requests/:id` (W5)
 * into the console's view. The plugin service returns the stored gate report
 * as recorded (`gateReport: { gates, facts }`) and the heuristics report
 * (`heuristics: { findings }`); both flat and nested forms are accepted.
 */
import { normalizeFindings, normalizeGate } from '@/lib/api/domains/plugin-submissions';
import type { SubmissionGate, SubmissionModerationView, SubmissionStatus } from '@/types/plugin-submissions';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizeSubmissionModeration(raw: unknown): SubmissionModerationView | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const report = (o.gateReport && typeof o.gateReport === 'object' ? o.gateReport : {}) as Record<string, unknown>;
  const facts = (report.facts && typeof report.facts === 'object' ? report.facts : null) as Record<string, unknown> | null;
  const gateList = Array.isArray(o.gates) ? o.gates : Array.isArray(report.gates) ? report.gates : [];
  const repo = facts ? str(facts.imageRepository) : null;
  const digest = facts ? str(facts.digest) : null;
  const vulnSource = (o.vuln && typeof o.vuln === 'object' && !('current' in (o.vuln as object)) ? o.vuln : facts) as Record<string, unknown> | null;
  return {
    id: String(o.id ?? ''),
    name: str(o.name),
    version: str(o.version),
    status: (str(o.status) ?? 'pending_review') as SubmissionStatus,
    newListing: o.newListing !== false,
    gates: gateList.map(normalizeGate).filter((g): g is SubmissionGate => g !== null),
    heuristics: normalizeFindings(o.heuristics),
    sbomUrl: str(o.sbomUrl),
    scanUrl: str(o.scanUrl),
    quarantineImage: str(o.quarantineImage) ?? (repo ? `${repo}${digest ? `@${digest}` : ''}` : null),
    vuln: vulnSource ? {
      critical: num(vulnSource.vulnCritical ?? vulnSource.critical),
      high: num(vulnSource.vulnHigh ?? vulnSource.high),
      medium: num(vulnSource.vulnMedium ?? vulnSource.medium),
      low: num(vulnSource.vulnLow ?? vulnSource.low),
      scannedAt: str(vulnSource.scannedAt),
    } : null,
    submittedAt: str(o.submittedAt) ?? '',
    verifiedAt: str(o.verifiedAt),
  };
}
