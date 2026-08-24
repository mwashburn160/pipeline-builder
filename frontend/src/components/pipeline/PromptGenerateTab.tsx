import { useState, useImperativeHandle, forwardRef, useCallback, useEffect, useRef } from 'react';
import { Sparkles, ChevronDown, Plug } from 'lucide-react';
import { BuilderProps, Plugin, GeneratedPluginRef, asGeneratedSynth, asGeneratedStages } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import PluginNameCombobox from '@/components/pipeline/editors/PluginNameCombobox';
import api from '@/lib/api';
import { AI_MAX_PROMPT_LENGTH, formatJSON } from '@/lib/constants';

/**
 * Methods exposed to the parent modal via ref. Intentionally identical to
 * {@link import('./GitUrlTab').GitUrlTabRef} so CreatePipelineModal can resolve
 * props/description/keywords through one uniform interface regardless of which
 * AI mode produced them.
 */
export interface PromptGenerateTabRef {
  /** Returns generated BuilderProps, or null if not yet generated. */
  getProps: () => Promise<BuilderProps | null>;
  /** Returns the AI-generated description string. */
  getDescription: () => string;
  /** Returns the AI-generated keywords as a comma-separated string. */
  getKeywords: () => string;
}

/** Props for the PromptGenerateTab component. */
interface PromptGenerateTabProps {
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
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
    <div className="rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-xl transition-colors"
      >
        <span className="flex items-center gap-2">
          <Plug className="w-4 h-4 text-gray-500 dark:text-gray-400" />
          Review Plugins
        </span>
        <ChevronDown className={`w-5 h-5 text-gray-400 dark:text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-200 dark:border-gray-700 space-y-4">
          <div className="pt-3">
            <PluginNameCombobox
              value={synth?.plugin?.name ?? ''}
              onChange={(name) => onPluginChange('synth', name, null)}
              onSelectPlugin={(plugin) => onPluginChange('synth', plugin.name, plugin)}
              disabled={disabled}
              label="Synth Plugin"
            />
          </div>
          {stages.map((stage, si) => (
            <div key={si}>
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
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

/**
 * Pipeline-create mode that generates a full pipeline configuration from a
 * free-text prompt via `POST /api/pipeline/generate/stream` (SSE). Mirrors the
 * plugin prompt builder's UX and reuses GitUrlTab's plugin-review + streaming
 * consumption pattern, but drives the prompt endpoint instead of repo analysis.
 */
const PromptGenerateTab = forwardRef<PromptGenerateTabRef, PromptGenerateTabProps>(
  ({ disabled }, ref) => {
    const [prompt, setPrompt] = useState('');
    const [generatedProps, setGeneratedProps] = useState<BuilderProps | null>(null);
    const [stageCount, setStageCount] = useState(0);
    const [generatedDescription, setGeneratedDescription] = useState('');
    const [generatedKeywords, setGeneratedKeywords] = useState('');
    const [projectOverride, setProjectOverride] = useState('');
    const [organizationOverride, setOrganizationOverride] = useState('');

    const ai = useAIProviders(() => api.getAIProviders());
    const { generating, error, preview: previewJson, setError, setPreview: setPreviewJson, generate } = useAiStreamGeneration();

    /** Update a plugin reference at the given path when the user swaps via combobox. */
    const handlePluginChange = useCallback((path: string, pluginName: string, plugin: Plugin | null) => {
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

      if (plugin) {
        target.filter = {
          id: plugin.id,
          orgId: plugin.orgId,
          version: plugin.version,
          accessModifier: plugin.accessModifier,
          isDefault: plugin.isDefault,
          isActive: plugin.isActive,
        };
        target.alias = undefined;
      }

      setGeneratedProps(updated);
      setPreviewJson(formatJSON(updated));
    }, [generatedProps]);

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        if (!generatedProps) {
          setError('Generate a configuration first using the button above.');
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

    // Set on unmount (e.g. the create modal closes mid-generation) so the async
    // stream loop stops consuming + stops calling setState on a dead component.
    const cancelledRef = useRef(false);
    useEffect(() => () => { cancelledRef.current = true; }, []);

    const handleGenerate = async () => {
      if (!prompt.trim()) {
        setError('Please describe the pipeline you want to generate.');
        return;
      }
      if (!ai.selectedProvider || !ai.selectedModel) {
        setError('Please select a provider and model.');
        return;
      }

      setGeneratedProps(null);
      setStageCount(0);
      setGeneratedDescription('');
      setGeneratedKeywords('');
      setProjectOverride('');
      setOrganizationOverride('');

      const keyToUse = ai.customApiKey.trim() || undefined;

      await generate<{ props: BuilderProps; description?: string; keywords?: string[] }>({
        stream: api.streamPipelineFromPrompt(prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse),
        cancelledRef,
        onPartial: (data) => {
          const d = data as Record<string, unknown>;
          if (Array.isArray(d.stages)) setStageCount(d.stages.length);
        },
        onDone: (data) => {
          setGeneratedProps(data.props);
          setPreviewJson(formatJSON(data.props));
          setGeneratedDescription(data.description || '');
          setGeneratedKeywords(Array.isArray(data.keywords) ? data.keywords.join(', ') : '');
          setProjectOverride(data.props.project || '');
          setOrganizationOverride(data.props.organization || '');
        },
      });
    };

    if (ai.loading) {
      return (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner size="md" className="mr-3" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading AI providers...</span>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <AiProviderModelPicker ai={ai} disabled={disabled || generating} />

        {/* Prompt Input */}
        <div>
          <label className="label">Describe your pipeline</label>
          <Textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setError(null); }}
            placeholder={'Example: "A CI/CD pipeline for a Node.js API: install deps, run unit tests, build a Docker image, then deploy to staging on the main branch."'}
            rows={4}
            className="text-sm"
            disabled={disabled || generating}
            maxLength={AI_MAX_PROMPT_LENGTH}
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {prompt.length}/{AI_MAX_PROMPT_LENGTH} characters
            </p>
            <Button
              onClick={handleGenerate}
              disabled={disabled || generating || !prompt.trim()}
            >
              {generating ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" />
                  Generate from prompt
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Streaming progress */}
        {generating && !previewJson && (
          <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 flex items-center gap-3">
            <LoadingSpinner size="sm" />
            <div>
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                Generating pipeline configuration...
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                {stageCount > 0
                  ? `Building pipeline — ${stageCount} stage${stageCount > 1 ? 's' : ''} generated so far`
                  : 'AI is building your pipeline — this may take a minute with local models'}
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        <ErrorAlert message={error || ai.error} />

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

        {/* Generated Output */}
        {previewJson && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label">Generated Configuration</label>
              {generating ? (
                <span className="text-xs text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1">
                  <LoadingSpinner size="sm" /> Streaming...
                </span>
              ) : (
                <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                  Ready to submit
                </span>
              )}
            </div>
            <pre className="input font-mono text-xs overflow-x-auto max-h-80 overflow-y-auto whitespace-pre">
              {previewJson}
            </pre>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Review the configuration above. Click &quot;Create&quot; to submit, or refine your prompt and regenerate.
            </p>
          </div>
        )}
      </div>
    );
  },
);

PromptGenerateTab.displayName = 'PromptGenerateTab';
export default PromptGenerateTab;
