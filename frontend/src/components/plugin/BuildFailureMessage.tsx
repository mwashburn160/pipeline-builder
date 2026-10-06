// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Callout } from '@/components/ui/Callout';
import type { BuildEvent } from '@/hooks/useBuildStatus';
import { buildFailureInfo, describeFinding } from '@/lib/plugin-vulns';
import { VulnWaiverNotice } from './VulnWaiverNotice';

export function BuildFailureMessage({ event, pluginName, className = '' }: { event: Pick<BuildEvent, 'message' | 'data'>; pluginName?: string; className?: string }) {
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
        {info.code === 'PLUGIN_VULN_GATE' && <VulnWaiverNotice pluginName={pluginName} />}
        {info.findings.length === 0 && info.code === 'PLUGIN_VULN_GATE' && (
          <p className="whitespace-pre-line text-xs opacity-90">{info.detail}</p>
        )}
      </div>
    </Callout>
  );
}
