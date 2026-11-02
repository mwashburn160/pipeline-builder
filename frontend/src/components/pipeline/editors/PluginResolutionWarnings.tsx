// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useDebounce } from '@/hooks/useDebounce';
import { useQuery } from '@/hooks/useQuery';
import { queries } from '@/lib/api-cache';
import { VULN_LOOKUP_WARNING_CODES } from '@/lib/plugin-vulns';
import { VulnWarningList } from '@/components/plugin/VulnSeverity';

/** Quiet period after the last keystroke before the reference is resolved. */
const LOOKUP_DEBOUNCE_MS = 600;

/**
 * What synth will say about a step's plugin reference, previewed in the editor:
 * the severity-graded vulnerability warnings the lookup answers —
 * `VULN_KEV` (critical), `VULN_FLAGGED` / `VULN_CRITICAL_FIXABLE` (error),
 * `VULN_HIGH_FIXABLE`, `UNSCANNED`, `SCAN_STALE`, `COMPLIANCE_VULN_RULE`
 * (warning or louder), `VULN_UPGRADE_AVAILABLE` with the version to move the pin
 * to, `VULN_ACCEPTED` when the pipeline accepted the risk, and
 * `COMPLIANCE_UNAVAILABLE`. Vulnerability state never refuses a pipeline, so
 * nothing here blocks the save. Other lookup outcomes (not found while typing,
 * the plugin's non-vulnerability warnings) stay with synth. Renders nothing
 * when clean.
 */
export function PluginResolutionWarnings({ name, publisher, version, id }: {
  name: string;
  publisher?: string;
  version?: string;
  id?: string;
}) {
  // Debounce a string: an object literal is a new value every render, which
  // would restart the timer (and re-render) forever.
  const debounced = useDebounce(
    JSON.stringify({
      name: name.trim(),
      ...(publisher?.trim() ? { publisher: publisher.trim() } : {}),
      ...(version?.trim() ? { version: version.trim() } : {}),
      ...(id?.trim() ? { id: id.trim() } : {}),
    }),
    LOOKUP_DEBOUNCE_MS,
  );
  const filter = JSON.parse(debounced) as { name: string; publisher?: string; version?: string; id?: string };
  const { data } = useQuery(filter.name ? queries.pluginLookup(filter) : null);

  const warnings = (data?.warnings ?? []).filter((w) => VULN_LOOKUP_WARNING_CODES.includes(w.code));
  if (warnings.length === 0) return null;
  return <VulnWarningList warnings={warnings} testId="plugin-resolution-warnings" />;
}
