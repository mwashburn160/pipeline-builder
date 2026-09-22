// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The review half of the two AI pipeline-create modes (from a Git URL, from a
 * prompt): the streaming progress banner, the project / organization overrides,
 * the plugin review (swap any AI-selected plugin) and the generated-JSON preview.
 * `useGeneratedProps` carries the matching logic — rewriting a plugin reference
 * and applying the overrides to what the modal submits.
 */

import { useCallback, useId, useState, type ReactNode } from 'react';
import { ChevronDown, Plug } from 'lucide-react';
import { type BuilderProps, type GeneratedPluginRef, asGeneratedStages, asGeneratedSynth } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import PluginNameCombobox from '@/components/pipeline/editors/PluginNameCombobox';
import { applyPluginPick, pickName, type PluginPick } from '@/lib/plugin-installs';
import { formatJSON } from '@/lib/constants';

type PluginChange = (path: string, pluginName: string, pick: PluginPick | null) => void;

interface GeneratedPropsState {
  generatedProps: BuilderProps | null;
  setGeneratedProps: (props: BuilderProps) => void;
  setPreviewJson: (json: string) => void;
  projectOverride: string;
  organizationOverride: string;
}

/**
 * `onPluginChange` rewrites the plugin at `synth` or `stages.<i>.steps.<j>`
 * (typing changes the name; a dropdown pick also rewrites publisher / filter)
 * and re-renders the preview; `withOverrides` is the config to submit, or null
 * before anything was generated.
 */
export function useGeneratedProps({
  generatedProps, setGeneratedProps, setPreviewJson, projectOverride, organizationOverride,
}: GeneratedPropsState) {
  const onPluginChange = useCallback<PluginChange>((path, pluginName, pick) => {
    if (!generatedProps) return;
    const updated = structuredClone(generatedProps);

    let target: GeneratedPluginRef;
    if (path === 'synth') {
      if (!updated.synth) return;
      target = asGeneratedSynth(updated.synth).plugin;
    } else {
      const [, stageIdx, , stepIdx] = path.split('.');
      const stages = asGeneratedStages(updated.stages);
      const si = Number(stageIdx);
      const stepI = Number(stepIdx);
      if (!stages?.[si]?.steps?.[stepI]) return;
      target = stages[si].steps[stepI].plugin;
    }

    target.name = pluginName;
    if (pick) applyPluginPick(target, pick);

    setGeneratedProps(updated);
    setPreviewJson(formatJSON(updated));
  }, [generatedProps, setGeneratedProps, setPreviewJson]);

  const withOverrides = useCallback((): BuilderProps | null => (generatedProps
    ? {
      ...generatedProps,
      project: projectOverride.trim() || generatedProps.project,
      organization: organizationOverride.trim() || generatedProps.organization,
    }
    : null), [generatedProps, projectOverride, organizationOverride]);

  return { onPluginChange, withOverrides };
}

/** Displays AI-selected plugins with combobox dropdowns for swapping. */
function PluginReviewSection({ props, onPluginChange, disabled }: {
  props: BuilderProps;
  onPluginChange: PluginChange;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const synth = asGeneratedSynth(props.synth);
  const stages = asGeneratedStages(props.stages);

  return (
    <div className="rounded-xl bg-surface-muted border border-default">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-fg-muted hover:bg-surface-muted rounded-xl transition-colors"
      >
        <span className="flex items-center gap-2">
          <Plug className="w-4 h-4 text-fg-muted" />
          Review Plugins
        </span>
        <ChevronDown className={`w-5 h-5 text-fg-subtle transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-default space-y-4">
          <div className="pt-3">
            <PluginNameCombobox
              value={synth?.plugin?.name ?? ''}
              publisher={synth?.plugin?.publisher}
              onChange={(name) => onPluginChange('synth', name, null)}
              onSelectPlugin={(pick) => onPluginChange('synth', pickName(pick), pick)}
              disabled={disabled}
              label="Synth plugin"
            />
          </div>
          {stages.map((stage, si) => (
            <div key={si}>
              <p className="text-xs font-semibold text-fg-muted mb-2">
                Stage: {stage.stageName}
              </p>
              <div className="space-y-3 pl-3">
                {(stage.steps ?? []).map((step, stepIdx) => (
                  <PluginNameCombobox
                    key={`${si}-${stepIdx}`}
                    value={step.plugin?.name ?? ''}
                    publisher={step.plugin?.publisher}
                    onChange={(name) => onPluginChange(`stages.${si}.steps.${stepIdx}`, name, null)}
                    onSelectPlugin={(pick) => onPluginChange(`stages.${si}.steps.${stepIdx}`, pickName(pick), pick)}
                    disabled={disabled}
                    label={`Step ${stepIdx + 1} Plugin`}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Progress while a generation streams. `role="status"` so a generation that
 * runs for a minute isn't silent to a screen reader; the JSON preview itself
 * stays un-announced (it would read out the whole config as it streams).
 */
export function GenerationProgress({ title, detail }: { title: string; detail: string }) {
  return (
    <div role="status" className="rounded-xl bg-info-bg border border-info-border p-4 flex items-center gap-3">
      <LoadingSpinner size="sm" label={null} />
      <div>
        <p className="text-sm font-medium text-info-strong">{title}</p>
        <p className="text-xs text-info mt-1">{detail}</p>
      </div>
    </div>
  );
}

/** "N stages generated so far", or the patience note before the first one. */
export function stageProgress(stageCount: number): string {
  return stageCount > 0
    ? `Building pipeline — ${stageCount} stage${stageCount > 1 ? 's' : ''} generated so far`
    : 'AI is building your pipeline — this may take a minute with local models';
}

interface GeneratedConfigReviewProps {
  generatedProps: BuilderProps | null;
  previewJson: string | null;
  generating: boolean;
  disabled?: boolean;
  projectOverride: string;
  setProjectOverride: (v: string) => void;
  organizationOverride: string;
  setOrganizationOverride: (v: string) => void;
  onPluginChange: PluginChange;
  /** Rendered between the plugin review and the preview (e.g. plugin status). */
  children?: ReactNode;
  /** The closing hint under the preview, e.g. "…or regenerate with a different URL." */
  regenerateHint: string;
}

/** Overrides, plugin review and the generated-JSON preview. */
export function GeneratedConfigReview({
  generatedProps, previewJson, generating, disabled,
  projectOverride, setProjectOverride, organizationOverride, setOrganizationOverride,
  onPluginChange, children, regenerateHint,
}: GeneratedConfigReviewProps) {
  const uid = useId();
  const locked = disabled || generating;
  return (
    <>
      {generatedProps && (
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Project">
            <Input
              type="text"
              value={projectOverride}
              onChange={(e) => setProjectOverride(e.target.value)}
              placeholder="Project name"
              className="text-sm"
              disabled={locked}
            />
          </FormField>
          <FormField label="Organization">
            <Input
              type="text"
              value={organizationOverride}
              onChange={(e) => setOrganizationOverride(e.target.value)}
              placeholder="Organization name"
              className="text-sm"
              disabled={locked}
            />
          </FormField>
        </div>
      )}

      {/* Swap AI-selected plugins before submitting */}
      {generatedProps && !generating && (
        <PluginReviewSection props={generatedProps} onPluginChange={onPluginChange} disabled={locked} />
      )}

      {children}

      {previewJson && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="label" id={`${uid}-generated-config`}>Generated configuration</span>
            {generating ? (
              <span className="text-xs text-info font-medium flex items-center gap-1">
                <LoadingSpinner size="sm" /> Streaming...
              </span>
            ) : (
              <span role="status" className="text-xs text-success font-medium">
                Ready to submit
              </span>
            )}
          </div>
          <pre aria-labelledby={`${uid}-generated-config`} className="input font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto whitespace-pre">
            {previewJson}
          </pre>
          <p className="mt-2 text-xs text-fg-muted">
            Review the configuration above. Click &quot;Create&quot; to submit, {regenerateHint}
          </p>
        </div>
      )}
    </>
  );
}
