// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Puzzle, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import api from '@/lib/api';
import { asGeneratedStages, asGeneratedSynth } from '@/types';
import type { BuilderProps, Pipeline } from '@/types';
import type { ComplianceCheckResult } from '@/types/compliance';

/** Distinct plugin names referenced by a pipeline's synth + stage steps. */
function pluginsFromProps(props: BuilderProps): string[] {
  const names = new Set<string>();
  const synth = asGeneratedSynth(props.synth || {});
  if (synth?.plugin?.name) names.add(synth.plugin.name);
  for (const stage of asGeneratedStages(props.stages)) {
    for (const step of stage.steps ?? []) {
      if (step?.plugin?.name) names.add(step.plugin.name);
    }
  }
  return [...names].sort();
}

/**
 * Cross-resource context for a pipeline: the plugins it uses and its live
 * compliance posture — surfaced on the detail page so a developer sees a
 * pipeline's dependencies and governance status in one place rather than
 * hopping to the Plugins and Compliance pages.
 */
export function PipelineContextCard({ pipeline }: { pipeline: Pipeline }) {
  const plugins = useMemo(() => pluginsFromProps(pipeline.props), [pipeline.props]);

  const [compliance, setCompliance] = useState<ComplianceCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    setCheckFailed(false);
    api.dryRunPipelineCompliance(pipeline.props as unknown as Record<string, unknown>)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) setCompliance(res.data);
        else setCheckFailed(true);
      })
      .catch(() => { if (!cancelled) setCheckFailed(true); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
    // Keyed on id, not the `props` object identity, so a parent re-render that
    // rebuilds `pipeline` doesn't re-fire the compliance dry-run network call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.id]);

  const posture = (() => {
    if (checking) return <span className="text-xs text-gray-400">Checking…</span>;
    if (checkFailed || !compliance) return <span className="text-xs text-gray-400">Unavailable</span>;
    if (compliance.blocked) return <Badge color="red">Blocked · {compliance.violations.length} violation{compliance.violations.length === 1 ? '' : 's'}</Badge>;
    if (compliance.warnings.length > 0) return <Badge color="yellow">{compliance.warnings.length} warning{compliance.warnings.length === 1 ? '' : 's'}</Badge>;
    return <Badge color="green">Passing</Badge>;
  })();

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Puzzle className="w-5 h-5 text-gray-500" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Plugins &amp; compliance</h3>
        </div>
        <Link href="/dashboard/plugins" className="action-link text-xs">View plugins →</Link>
      </div>

      <div className="text-sm">
        <div className="flex items-center justify-between mb-2">
          <span className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
            <ShieldCheck className="w-4 h-4" /> Compliance posture
          </span>
          {posture}
        </div>
        {compliance && compliance.rulesEvaluated > 0 && (
          <p className="text-[11px] text-gray-400 mb-3">{compliance.rulesEvaluated} rule{compliance.rulesEvaluated === 1 ? '' : 's'} evaluated</p>
        )}

        <dl>
          <dt className="text-gray-500 dark:text-gray-400 mb-1">Plugins used ({plugins.length})</dt>
          <dd className="flex flex-wrap gap-1">
            {plugins.length === 0
              ? <span className="text-gray-400 text-xs">None referenced</span>
              : plugins.map((name) => (
                  <span key={name} className="px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-mono">{name}</span>
                ))}
          </dd>
        </dl>
      </div>
    </Card>
  );
}
