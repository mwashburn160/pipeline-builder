// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build a Grafana Explore deep-link for the registry audit event(s) that
 * correspond to a specific mutation. Used by every flow that performs an
 * audit-logged action (copy, delete, bulk delete) so the operator can
 * verify the event landed without leaving Pipeline Builder.
 *
 * Loki is exposed at `/grafana/` behind nginx; this builder constructs an
 * Explore-mode URL that pre-populates the LogQL query and a time range
 * surrounding the action's timestamp.
 *
 * Promtail/Loki wiring (see deploy/{local,minikube,aws/ec2}/config/promtail
 * promtail-config.yml): the shipper extracts `eventCategory` and `event`
 * from the structured JSON log and promotes them to Loki labels. The bare
 * `msg` field is then used as the log line content. That means stream
 * selectors on those two labels work, but a `|= "<digest>"` line filter
 * does NOT — the digest never lands in the line text. The query below
 * therefore narrows on event name + time window only; the operator scans
 * visually within the 10-minute span.
 */

const LOKI_DATASOURCE = 'loki';
const TIME_WINDOW_MS = 5 * 60_000; // 5 minutes either side of the event

interface CopyAuditLink {
  kind: 'copy';
  /** ISO timestamp when the copy occurred. */
  at: string;
  digest?: string;
  source?: string;
  target?: string;
}

interface DeleteAuditLink {
  kind: 'delete';
  at: string;
  digest?: string;
  repo?: string;
  ref?: string;
}

export type AuditLinkSpec = CopyAuditLink | DeleteAuditLink;

/**
 * Build a Grafana Explore URL pre-filtered to the audit event matching the spec.
 * Returns null when the spec doesn't carry enough information to construct
 * a useful filter (caller should hide the link in that case).
 */
export function buildAuditLogLink(spec: AuditLinkSpec): string | null {
  if (!spec.at) return null;

  const event = spec.kind === 'copy' ? 'registry.tag.copy' : 'registry.tag.delete';
  // Stream selector only — see the file header comment for why a line
  // filter on the digest wouldn't survive the Promtail `output.source: msg`
  // rewrite. The (event name × ±5min window × service_name) narrowing
  // typically leaves 1-2 hits to eyeball.
  const expr = `{eventCategory="audit",event="${event}",service_name="image-registry"}`;

  const eventTime = new Date(spec.at).getTime();
  const from = eventTime - TIME_WINDOW_MS;
  const to = eventTime + TIME_WINDOW_MS;

  // Grafana Explore URL state — the `left` param encodes the panel.
  // Format matches Grafana 10+; older versions accept it too.
  const left = {
    datasource: LOKI_DATASOURCE,
    queries: [{ refId: 'A', expr, queryType: 'range' }],
    range: { from: String(from), to: String(to) },
  };

  return `/grafana/explore?orgId=1&left=${encodeURIComponent(JSON.stringify(left))}`;
}
