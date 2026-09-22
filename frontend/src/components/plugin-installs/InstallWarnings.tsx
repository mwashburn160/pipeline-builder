// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { severityColor, severityLabel, sortBySeverity } from '@/lib/advisories';
import type { InstallView } from '@/types/plugin-installs';

/**
 * What resolving an install's version warns about: the advisories
 * covering it — red when an advisory BLOCKS resolution under the org's
 * `blockOnAdvisory` policy — and the lookup's other warnings (deprecated,
 * unmaintained, secrets withheld). Renders nothing when there's nothing to say.
 */
export function InstallWarnings({ install }: { install: Pick<InstallView, 'warnings' | 'advisories'> }) {
  const advisories = sortBySeverity(install.advisories);
  // The advisory warning restates the advisories listed below; keep it only if none are listed.
  const warnings = install.warnings.filter((w) => w.code !== 'PLUGIN_ADVISORY' || advisories.length === 0);
  if (advisories.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label="Install warnings" data-testid="install-warnings">
      {advisories.map((a) => (
        <li
          key={a.id}
          className={`flex flex-wrap items-center gap-1.5 ${a.blocking ? 'text-danger-strong' : 'text-warning-strong'}`}
          data-testid={a.blocking ? 'install-advisory-blocking' : 'install-advisory'}
          title={a.fixedVersion ? `Fixed in v${a.fixedVersion}` : 'No fixed version yet'}
        >
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {a.blocking ? <Badge color="red">Blocked by advisory</Badge> : <Badge color={severityColor(a.severity)}>{severityLabel(a.severity)} advisory</Badge>}
          <span>{a.summary}</span>
          {a.fixedVersion && <span className="text-fg-muted">· fixed in v{a.fixedVersion}</span>}
        </li>
      ))}
      {warnings.map((w) => (
        <li key={`${w.code}:${w.message}`} className="flex items-start gap-1.5 text-warning-strong" data-testid={`install-warning-${w.code}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}
