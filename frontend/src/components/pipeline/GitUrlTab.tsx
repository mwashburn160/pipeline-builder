import { useState, useImperativeHandle, forwardRef, useCallback } from 'react';
import { GitBranch, ChevronDown, Plug, Loader } from 'lucide-react';
import { BuilderProps, Plugin, GeneratedPluginRef, asGeneratedSynth, asGeneratedStages } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useRepoAnalysis } from '@/hooks/internal/useRepoAnalysis';
import PluginNameCombobox from '@/components/pipeline/editors/PluginNameCombobox';
import { PrivateRepoFields } from '@/components/pipeline/PrivateRepoFields';
import { AnalysisResultPanel, PluginStatusPanel } from '@/components/pipeline/AnalysisResultPanel';
import { formatJSON } from '@/lib/constants';

/** Methods exposed to the parent modal via ref. */
export interface GitUrlTabRef {
  /** Returns generated BuilderProps, or null if not yet generated. */
  getProps: () => Promise<BuilderProps | null>;
  /** Returns the AI-generated description string. */
  getDescription: () => string;
  /** Returns the AI-generated keywords as a comma-separated string. */
  getKeywords: () => string;
}

/** Props for the GitUrlTab component. */
interface GitUrlTabProps {
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
  /** Optional pre-filled Git URL (from dashboard home). */
  initialUrl?: string;
  /** If true, auto-starts generation when initialUrl is provided. */
  autoGenerate?: boolean;
}

/** Props for the inline plugin review section. */
interface PluginReviewSectionProps {
  props: BuilderProps;
  onPluginChange: (path: string, pluginName: string, plugin: Plugin | null) => void;
  disabled?: boolean;
}

/** Displays AI-selected plugins with combobox dropdowns for swapping. */
function PluginReviewSection({ props, onPluginChange, disabled }: PluginReviewSectionProps) {
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
          {/* Synth plugin */}
          <div className="pt-3">
            <PluginNameCombobox
              value={synth?.plugin?.name ?? ''}
              onChange={(name) => onPluginChange('synth', name, null)}
              onSelectPlugin={(plugin) => onPluginChange('synth', plugin.name, plugin)}
              disabled={disabled}
              label="Synth Plugin"
            />
          </div>

          {/* Stage step plugins */}
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
                    onChange={(name) => onPluginChange(`stages.${si}.steps.${stepIdx}`, name, null)}
                    onSelectPlugin={(plugin) => onPluginChange(`stages.${si}.steps.${stepIdx}`, plugin.name, plugin)}
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

const GitUrlTab = forwardRef<GitUrlTabRef, GitUrlTabProps>(
  ({ disabled, initialUrl, autoGenerate }, ref) => {
    const {
      gitUrl, setGitUrl,
      repoToken, setRepoToken,
      analyzing, analysis,
      generatedProps, setGeneratedProps,
      stageCount, generatedDescription, generatedKeywords,
      checkingPlugins, pluginStatus,
      projectOverride, setProjectOverride,
      organizationOverride, setOrganizationOverride,
      ai, generating, error, setError,
      previewJson, setPreviewJson,
      generate: handleGenerate,
    } = useRepoAnalysis({ initialUrl, autoGenerate });

    /** Update a plugin reference at the given path when the user swaps via combobox. */
    const handlePluginChange = useCallback((path: string, pluginName: string, plugin: Plugin | null) => {
      if (!generatedProps) return;
      const updated = structuredClone(generatedProps);

      // Locate the target plugin ref
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

      // Always update name (covers both typing and dropdown selection)
      target.name = pluginName;

      // If a full Plugin record was provided (dropdown selection), update filter + clear alias
      if (plugin) {
        target.filter = {
          id: plugin.id,
          orgId: plugin.orgId,
          version: plugin.version,
          visibility: plugin.visibility,
          isDefault: plugin.isDefault,
          isActive: plugin.isActive,
        };
        target.alias = undefined;
      }

      setGeneratedProps(updated);
      setPreviewJson(formatJSON(updated));
    }, [generatedProps, setGeneratedProps, setPreviewJson]);

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        if (!generatedProps) {
          setError('Generate a configuration first using the button below.');
          return null;
        }
        return {
          ...generatedProps,
          project: projectOverride.trim() || generatedProps.project,
          organization: organizationOverride.trim() || generatedProps.organization,
        };
      },
      getDescription: () => generatedDescription,
      getKeywords: () => generatedKeywords,
    }));

    if (ai.loading) {
      return (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="md" className="mr-3" />
          <span className="text-sm text-fg-muted">Loading AI providers...</span>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Git URL Input */}
        <div>
          <label className="label">Git Repository URL</label>
          <Input
            type="text"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="text-sm"
            disabled={disabled || generating}
          />
          <p className="text-xs text-fg-subtle mt-1">
            Supports GitHub, GitLab, Bitbucket, and self-hosted Git URLs.
          </p>
        </div>

        <PrivateRepoFields
          value={repoToken}
          onChange={setRepoToken}
          disabled={disabled || generating}
        />

        <AiProviderModelPicker ai={ai} disabled={disabled || generating} />

        {/* Generate Button */}
        <div className="flex justify-end">
          <Button
            onClick={handleGenerate}
            disabled={disabled || generating || !gitUrl.trim()}
          >
            {generating ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                {analyzing ? 'Analyzing repository...' : 'Generating...'}
              </>
            ) : (
              <>
                <GitBranch className="w-4 h-4 mr-2" />
                Generate from URL
              </>
            )}
          </Button>
        </div>

        {/* Streaming progress */}
        {generating && !previewJson && (
          // role="status" — repo analysis + generation can run for a minute, and
          // was entirely silent to a screen reader.
          <div role="status" className="rounded-xl bg-info-bg border border-info-border p-4 flex items-center gap-3">
            <LoadingSpinner size="sm" label={null} />
            <div>
              <p className="text-sm font-medium text-info-strong">
                {analyzing ? 'Analyzing repository structure...' : 'Generating pipeline configuration...'}
              </p>
              <p className="text-xs text-info mt-1">
                {analyzing
                  ? 'Scanning files, languages, and frameworks'
                  : stageCount > 0
                    ? `Building pipeline — ${stageCount} stage${stageCount > 1 ? 's' : ''} generated so far`
                    : 'AI is building your pipeline — this may take a minute with local models'}
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        <ErrorAlert message={error || ai.error} />

        {analysis && <AnalysisResultPanel analysis={analysis} />}

        {/* Project & Organization Override */}
        {generatedProps && (
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Project">
              <Input
                type="text"
                value={projectOverride}
                onChange={(e) => setProjectOverride(e.target.value)}
                placeholder="Project name"
                className="text-sm"
                disabled={disabled || generating}
              />
            </FormField>
            <FormField label="Organization">
              <Input
                type="text"
                value={organizationOverride}
                onChange={(e) => setOrganizationOverride(e.target.value)}
                placeholder="Organization name"
                className="text-sm"
                disabled={disabled || generating}
              />
            </FormField>
          </div>
        )}

        {/* Plugin Review — lets user swap AI-selected plugins before submitting */}
        {generatedProps && !generating && (
          <PluginReviewSection
            props={generatedProps}
            onPluginChange={handlePluginChange}
            disabled={disabled || generating}
          />
        )}

        {/* Plugin Status */}
        {checkingPlugins && (
          <div className="rounded-xl bg-info-bg border border-info-border p-4">
            <div className="flex items-center gap-2">
              <Loader className="w-4 h-4 text-brand animate-spin" />
              <span className="text-sm text-info-strong font-medium">Checking referenced plugins...</span>
            </div>
          </div>
        )}
        {pluginStatus && <PluginStatusPanel status={pluginStatus} />}

        {/* Generated Output */}
        {previewJson && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label">Generated Configuration</label>
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
            <pre className="input font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto whitespace-pre">
              {previewJson}
            </pre>
            <p className="mt-2 text-xs text-fg-muted">
              Review the configuration above. Click &quot;Create&quot; to submit, or regenerate with a different URL.
            </p>
          </div>
        )}
      </div>
    );
  },
);

GitUrlTab.displayName = 'GitUrlTab';
export default GitUrlTab;
