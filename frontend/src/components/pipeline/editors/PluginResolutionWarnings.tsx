// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ShieldAlert } from 'lucide-react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQuery } from '@/hooks/useQuery';
import { queries } from '@/lib/api-cache';
import { ApiError } from '@/lib/api/errors';
import { PLUGIN_VERSION_VULN_BLOCKED, VULN_FLAGGED, describeFinding, normalizeVulnFindings } from '@/lib/plugin-vulns';

/** Quiet period after the last keystroke before the reference is resolved. */
const LOOKUP_DEBOUNCE_MS = 600;

/**
 * What synth will say about a step's plugin reference, previewed in the
 * editor: a `VULN_FLAGGED` warning when the version it resolves to has fixable
 * Critical findings from a rescan, and — when the platform blocks flagged
 * versions — the refusal of an exact pin to one, worded by the server with the
 * version that fixes it. Other lookup outcomes (not found while typing, the
 * plugin's other warnings) stay with synth. Renders nothing when clean.
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
  const { data, error } = useQuery(filter.name ? queries.pluginLookup(filter) : null);

  const flagged = (data?.warnings ?? []).filter((w) => w.code === VULN_FLAGGED);
  const blocked = error instanceof ApiError && error.code === PLUGIN_VERSION_VULN_BLOCKED ? error.message : null;
  if (!blocked && flagged.length === 0) return null;

  return (
    <ul className="space-y-1 text-xs" aria-label="Plugin vulnerability warnings" data-testid="plugin-resolution-warnings">
      {blocked && (
        <li className="flex items-start gap-1.5 text-danger-strong" data-testid="plugin-vuln-blocked">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{blocked}</span>
        </li>
      )}
      {flagged.map((w) => (
        <li key={`${w.plugin ?? ''}@${w.version ?? ''}:${w.message}`} className="flex items-start gap-1.5 text-warning-strong" data-testid="plugin-vuln-flagged">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {w.message}
            {normalizeVulnFindings(w.findings).length > 0 && (
              <span className="block font-mono text-fg-muted">
                {normalizeVulnFindings(w.findings).slice(0, 3).map(describeFinding).join('; ')}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
