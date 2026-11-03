// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Globe, Code, Package, Plug, CheckCircle, AlertCircle, Loader } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import type { RepoAnalysisData, MissingPluginProposal, PluginCreationStatus } from '@/hooks/internal/useRepoAnalysis';

/**
 * Shared shell for the two read-only panels the generation stream fills in.
 * Uses the surface/border tokens, so it re-resolves with the theme instead of
 * carrying a light/dark class pair.
 */
function Panel({ icon: Icon, heading, children }: { icon: typeof Globe; heading: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-muted border border-default p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-fg-muted" />
        {heading}
      </div>
      {children}
    </div>
  );
}

/** A small rounded tag. `tone` picks the tinted pair. */
function Chip({ tone, children }: { tone: keyof typeof CHIP_TONES; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${CHIP_TONES[tone]}`}>
      {children}
    </span>
  );
}

// `purple`, `cyan` and `orange` have no semantic token (the set is brand plus
// success/warning/danger/info), so those three stay on the raw palette.
const CHIP_TONES = {
  info: 'bg-info-bg text-info-strong',
  success: 'bg-success-bg text-success-strong',
  warning: 'bg-warning-bg text-warning-strong',
  danger: 'bg-danger-bg text-danger-strong',
  neutral: 'bg-surface-muted text-fg-muted',
  purple: 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300',
  cyan: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-300',
  orange: 'bg-warning-bg text-warning-strong',
} as const;

/** What the backend found in the repo, as a row of chips. */
export function AnalysisResultPanel({ analysis }: { analysis: RepoAnalysisData }) {
  return (
    <Panel
      icon={Globe}
      heading={
        <>
          <span className="text-sm font-medium text-fg-muted">{analysis.owner}/{analysis.repo}</span>
          <span className="text-xs text-fg-subtle">({analysis.provider}) · {analysis.defaultBranch}</span>
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {analysis.projectType !== 'unknown' && (
          <Chip tone="info"><Code className="w-3 h-3" />{analysis.projectType}</Chip>
        )}
        {analysis.packageManager !== 'unknown' && (
          <Chip tone="success"><Package className="w-3 h-3" />{analysis.packageManager}</Chip>
        )}
        {analysis.frameworks.map((fw) => <Chip key={fw} tone="purple">{fw}</Chip>)}
        {Object.entries(analysis.languages).slice(0, 3).map(([lang, pct]) => (
          <Chip key={lang} tone="neutral">{lang} {pct}%</Chip>
        ))}
        {analysis.hasDockerfile && <Chip tone="cyan">Docker</Chip>}
        {analysis.hasCdkJson && <Chip tone="orange">AWS CDK</Chip>}
      </div>
      {analysis.description && <p className="text-xs text-fg-muted mt-2">{analysis.description}</p>}
    </Panel>
  );
}

/**
 * The plugins a generated config references but the org lacks — a PROPOSAL the
 * user reviews. Each creatable name is a checkbox (all ticked by default); the
 * button creates exactly the ticked ones, and only when pressed. Refused names
 * (a listed plugin, an unsafe name) are shown with why, never offered.
 */
export function MissingPluginsPanel({ proposal, creating, disabled, canCreate = true, onConfirm }: {
  proposal: MissingPluginProposal;
  creating: boolean;
  disabled?: boolean;
  /** `plugins:write` — the confirm route's gate. Without it the proposal still shows, the button is inert and says why. */
  canCreate?: boolean;
  onConfirm: (names: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(proposal.proposed);
  const toggle = (name: string) =>
    setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  const nothingMissing = proposal.proposed.length === 0 && proposal.refused.length === 0;
  return (
    <Panel icon={Plug} heading={<span className="text-sm font-medium text-fg-muted">Referenced plugins</span>}>
      <div className="space-y-3">
        {proposal.existing.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {proposal.existing.map((name) => (
              <Chip key={name} tone="success"><CheckCircle className="w-3 h-3" />{name}</Chip>
            ))}
          </div>
        )}
        {nothingMissing && <p className="text-xs text-success">All referenced plugins already exist.</p>}
        {proposal.proposed.length > 0 && (
          <div data-testid="missing-plugins-proposal">
            <p className="text-xs text-fg-muted mb-2">
              Not in your organization yet. Create placeholders for the ones you want — each fails its build
              step until you implement it. Nothing is created until you confirm.
            </p>
            <div className="space-y-1">
              {proposal.proposed.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm text-fg">
                  <Checkbox checked={selected.includes(name)} onChange={() => toggle(name)} disabled={creating || disabled} />
                  <span className="font-mono text-xs">{name}</span>
                </label>
              ))}
            </div>
            <Button
              className="mt-3"
              variant="secondary"
              onClick={() => onConfirm(selected)}
              disabled={creating || disabled || !canCreate || selected.length === 0}
            >
              {creating ? <><Loader className="w-4 h-4 mr-2 animate-spin" />Creating...</> : `Create ${selected.length} placeholder plugin${selected.length === 1 ? '' : 's'}`}
            </Button>
            {!canCreate && (
              <p className="text-2xs text-fg-muted mt-1">Creating plugins needs the plugins:write permission.</p>
            )}
          </div>
        )}
        {proposal.refused.length > 0 && (
          <div>
            <p className="text-xs text-fg-muted mb-1">Not created:</p>
            <div className="flex flex-wrap gap-2">
              {proposal.refused.map((r) => (
                <Chip key={r.name} tone="danger">
                  <AlertCircle className="w-3 h-3" />{r.name}<span className="text-2xs opacity-75 ml-1">({r.error})</span>
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/** What the user's confirmed placeholder creation did. */
export function PluginStatusPanel({ status }: { status: PluginCreationStatus }) {
  return (
    <Panel icon={Plug} heading={<span className="text-sm font-medium text-fg-muted">Plugin status</span>}>
      <div className="space-y-2">
        {status.builds.length > 0 && (
          <div>
            <p className="text-xs text-fg-muted mb-1">Placeholder plugins:</p>
            <div className="flex flex-wrap gap-2">
              {status.builds.map((b) => (
                <Chip key={b.name} tone={b.error ? 'danger' : 'warning'}>
                  {b.error ? <AlertCircle className="w-3 h-3" /> : <Loader className="w-3 h-3 animate-spin" />}
                  {b.name}
                  {b.error && <span className="text-2xs opacity-75 ml-1">({b.error})</span>}
                </Chip>
              ))}
            </div>
            {status.builds.some((b) => !b.error) && (
              <p className="text-xs text-warning mt-1">
                Plugin builds started — they&apos;ll be ready shortly. You can create the pipeline now.
              </p>
            )}
          </div>
        )}
        {status.created.length === 0 && status.existing.length > 0 && (
          <p className="text-xs text-success">Those plugins already exist.</p>
        )}
      </div>
    </Panel>
  );
}
