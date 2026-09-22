// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout } from '@/components/ui/Callout';
import type { BuildEvent } from '@/hooks/useBuildStatus';
import { buildFailureInfo, describeFinding } from '@/lib/plugin-vulns';

/**
 * A failed plugin build, explained. The two scan gates get their own words — an
 * image the scanner could not reach (`IMAGE_SCAN_UNAVAILABLE`) and one refused
 * for fixable Critical vulnerabilities (`PLUGIN_VULN_GATE`, with each CVE and
 * the version that fixes it) — and anything else shows the server's summary
 * (exit reason and the build log's tail) as it was sent.
 */
export function BuildFailureMessage({ event, className = '' }: { event: Pick<BuildEvent, 'message' | 'data'>; className?: string }) {
  const info = buildFailureInfo(event);
  if (!info.code) {
    return (
      <Callout variant="danger" className={className}>
        <span className="whitespace-pre-line" data-testid="build-failure-message">{info.message}</span>
      </Callout>
    );
  }
  return (
    <Callout variant="danger" title={info.title} className={className}>
      <div className="space-y-2" data-testid={`build-failure-${info.code}`}>
        <p>{info.message}</p>
        {info.findings.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs" aria-label="Blocking vulnerabilities">
            {info.findings.map((f) => <li key={f.id}>{describeFinding(f)}</li>)}
          </ul>
        )}
        {info.findings.length === 0 && info.code === 'PLUGIN_VULN_GATE' && (
          <p className="whitespace-pre-line text-xs opacity-90">{info.detail}</p>
        )}
      </div>
    </Callout>
  );
}
