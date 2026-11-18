// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read the `submission` block of `GET /plugins/ecosystem/requests/:id`
 * into the console's view. The plugin service returns the stored gate report
 * as recorded (`gateReport: { gates, facts }`) and the heuristics report
 * (`heuristics: { findings }`).
 */
import { normalizeFindings, normalizeGate } from '@/lib/api/domains/plugin-submissions';
import type { SubmissionGate, SubmissionModerationView, SubmissionStatus } from '@/types/plugin-submissions';

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? v as Record<string, unknown> : null);

export function normalizeSubmissionModeration(raw: unknown): SubmissionModerationView | null {
  const o = obj(raw);
  if (!o) return null;
  const report = obj(o.gateReport);
  const facts = report ? obj(report.facts) : null;
  const gateList = report && Array.isArray(report.gates) ? report.gates : [];
  const repo = facts ? str(facts.imageRepository) : null;
  const digest = facts ? str(facts.digest) : null;
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
    quarantineImage: repo ? `${repo}${digest ? `@${digest}` : ''}` : null,
    vuln: facts ? {
      critical: num(facts.vulnCritical),
      high: num(facts.vulnHigh),
      medium: num(facts.vulnMedium),
      low: num(facts.vulnLow),
      scannedAt: str(facts.scannedAt),
    } : null,
    submittedAt: str(o.submittedAt) ?? '',
    verifiedAt: str(o.verifiedAt),
  };
}
