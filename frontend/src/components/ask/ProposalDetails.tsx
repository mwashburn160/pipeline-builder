// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { CodeBlock } from '@/components/ui/CodeBlock';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import type { Proposal } from './proposal';
import { isDiffProposal, proposalDiff } from './proposal';
import { ProposalDiffView } from './ProposalDiffView';

/**
 * The review body of a proposal card.
 *
 * An EDIT proposal is reviewed as a CURRENT -> PROPOSED diff, never as a JSON
 * blob: a blob gets skimmed, and the diff is also literally the commit payload,
 * so a field that is not on screen cannot be applied.
 */
export function ProposalDetails({ p }: { p: Proposal }) {
  const json = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

  if (isDiffProposal(p)) return <ProposalDiffView diff={proposalDiff(p)} />;

  if (p.kind === 'plugin') {
    const c = (p.config ?? {}) as Record<string, unknown>;
    const cmds = [...(Array.isArray(c.installCommands) ? c.installCommands : []), ...(Array.isArray(c.commands) ? c.commands : [])];
    const items: DescriptionItem[] = [
      { label: 'Name', value: String(c.name ?? '—') },
      { label: 'Version', value: String(c.version ?? '—') },
      { label: 'Type', value: String(c.pluginType ?? '—') },
      { label: 'Compute', value: String(c.computeType ?? '—') },
      ...(c.primaryOutputDirectory ? [{ label: 'Output dir', value: String(c.primaryOutputDirectory) }] : []),
    ];
    return (
      <div className="space-y-2">
        <DescriptionList items={items} variant="rows" />
        {cmds.length > 0 && <CodeBlock language="commands" code={cmds.join('\n')} className="max-h-52 overflow-y-auto" />}
        {p.dockerfile && <CodeBlock language="Dockerfile" code={p.dockerfile} className="max-h-64 overflow-y-auto" />}
      </div>
    );
  }

  if (p.kind === 'template') {
    const t = (p.template ?? {}) as Record<string, unknown>;
    const inputs = (Array.isArray(t.inputs) ? t.inputs : []) as Array<{ name?: string }>;
    const items: DescriptionItem[] = [
      { label: 'Name', value: String(t.name ?? '—') },
      ...(t.category ? [{ label: 'Category', value: String(t.category) }] : []),
      { label: 'Variables', value: inputs.length ? inputs.map((i) => i.name).filter(Boolean).join(', ') : 'none' },
    ];
    return (
      <div className="space-y-2">
        <DescriptionList items={items} variant="rows" />
        <CodeBlock language="template props (JSON)" code={json(t.props)} className="max-h-64 overflow-y-auto" />
      </div>
    );
  }

  const pr = (p.props ?? {}) as Record<string, unknown>;
  const varNames = pr.vars && typeof pr.vars === 'object' ? Object.keys(pr.vars as object) : [];
  const items: DescriptionItem[] = [
    { label: 'Project', value: String(pr.project ?? '—') },
    { label: 'Organization', value: String(pr.organization ?? '—') },
    ...(pr.pipelineName ? [{ label: 'Name', value: String(pr.pipelineName) }] : []),
    { label: 'Stages', value: String(Array.isArray(pr.stages) ? pr.stages.length : 0) },
    ...(varNames.length ? [{ label: 'Variables', value: varNames.join(', ') }] : []),
  ];
  return (
    <div className="space-y-2">
      <DescriptionList items={items} variant="rows" />
      <CodeBlock language="pipeline props (JSON)" code={json(pr)} className="max-h-64 overflow-y-auto" />
    </div>
  );
}
