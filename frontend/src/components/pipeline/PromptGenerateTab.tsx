import { useState, useImperativeHandle, forwardRef, useCallback, useEffect, useRef } from 'react';
import { Sparkles, ChevronDown, ChevronUp, Plug } from 'lucide-react';
import { BuilderProps, Plugin, GeneratedPluginRef, asGeneratedSynth, asGeneratedStages } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useAIProviders } from '@/hooks/useAIProviders';
import { getProviderSourceLabel } from '@/lib/ai-constants';
import PluginNameCombobox from '@/components/pipeline/editors/PluginNameCombobox';
import api from '@/lib/api';
import { AI_MAX_PROMPT_LENGTH, formatError, formatJSON } from '@/lib/constants';

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
    const [generating, setGenerating] = useState(false);
    const [generatedProps, setGeneratedProps] = useState<BuilderProps | null>(null);
    const [stageCount, setStageCount] = useState(0);
    const [generatedDescription, setGeneratedDescription] = useState('');
    const [generatedKeywords, setGeneratedKeywords] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [previewJson, setPreviewJson] = useState<string | null>(null);
    const [projectOverride, setProjectOverride] = useState('');
    const [organizationOverride, setOrganizationOverride] = useState('');

    const ai = useAIProviders(() => api.getAIProviders());

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

      setError(null);
      setGenerating(true);
      setGeneratedProps(null);
      setStageCount(0);
      setPreviewJson(null);
      setGeneratedDescription('');
      setGeneratedKeywords('');
      setProjectOverride('');
      setOrganizationOverride('');

      try {
        const keyToUse = ai.customApiKey.trim() || undefined;

        for await (const event of api.streamPipelineFromPrompt(
          prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse,
        )) {
          if (cancelledRef.current) break; // unmounted mid-stream — stop reading
          switch (event.type) {
            case 'partial':
              if (event.data) {
                setPreviewJson(formatJSON(event.data));
                const d = event.data as Record<string, unknown>;
                if (Array.isArray(d.stages)) setStageCount(d.stages.length);
              }
              break;
            case 'done':
              if (event.data) {
                const data = event.data as { props: BuilderProps; description?: string; keywords?: string[] };
                setGeneratedProps(data.props);
                setPreviewJson(formatJSON(data.props));
                setGeneratedDescription(data.description || '');
                setGeneratedKeywords(Array.isArray(data.keywords) ? data.keywords.join(', ') : '');
                setProjectOverride(data.props.project || '');
                setOrganizationOverride(data.props.organization || '');
              }
              break;
            case 'error':
              setError(event.message || 'Generation failed');
              break;
          }
        }
      } catch (err: unknown) {
        if (!cancelledRef.current) setError(formatError(err, 'Generation failed'));
      } finally {
        if (!cancelledRef.current) setGenerating(false);
      }
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
        {/* Provider and Model Selection */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Provider</label>
            <select
              value={ai.selectedProvider}
              onChange={(e) => ai.setSelectedProvider(e.target.value)}
              className="input"
              disabled={disabled || generating}
            >
              {ai.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {getProviderSourceLabel(p)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Model</label>
            <select
              value={ai.selectedModel}
              onChange={(e) => ai.setSelectedModel(e.target.value)}
              className="input"
              disabled={disabled || generating}
            >
              {ai.currentModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Custom API Key Override */}
        <div>
          <button
            type="button"
            onClick={() => ai.setShowKeyOverride(!ai.showKeyOverride)}
            className="flex items-center text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          >
            {ai.showKeyOverride ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            {ai.currentSource === 'none' ? 'Enter API key' : 'Use custom API key'}
          </button>
          {ai.showKeyOverride && (
            <div className="mt-2">
              <input
                type="password"
                autoComplete="off"
                value={ai.customApiKey}
                onChange={(e) => ai.setCustomApiKey(e.target.value)}
                placeholder={
                  ai.currentSource === 'none'
                    ? 'Enter API key for this provider'
                    : ai.currentSource === 'org' ? 'Leave empty to use organization key' : 'Leave empty to use server key'
                }
                className="input text-sm"
                disabled={disabled || generating}
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                {ai.currentSource === 'none'
                  ? 'An API key is required to use this provider.'
                  : `Overrides the ${ai.currentSource === 'org' ? 'organization' : 'server'} key for this request only.`}
              </p>
            </div>
          )}
        </div>

        {/* Prompt Input */}
        <div>
          <label className="label">Describe your pipeline</label>
          <textarea
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setError(null); }}
            placeholder={'Example: "A CI/CD pipeline for a Node.js API: install deps, run unit tests, build a Docker image, then deploy to staging on the main branch."'}
            rows={4}
            className="input text-sm"
            disabled={disabled || generating}
            maxLength={AI_MAX_PROMPT_LENGTH}
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {prompt.length}/{AI_MAX_PROMPT_LENGTH} characters
            </p>
            <button
              onClick={handleGenerate}
              disabled={disabled || generating || !prompt.trim()}
              className="btn btn-primary"
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
            </button>
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
        {(error || ai.error) && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
            <p className="text-sm text-red-800 dark:text-red-300">{error || ai.error}</p>
          </div>
        )}

        {/* Project & Organization Override */}
        {generatedProps && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Project</label>
              <input
                type="text"
                value={projectOverride}
                onChange={(e) => setProjectOverride(e.target.value)}
                placeholder="Project name"
                className="input text-sm"
                disabled={disabled || generating}
              />
            </div>
            <div>
              <label className="label">Organization</label>
              <input
                type="text"
                value={organizationOverride}
                onChange={(e) => setOrganizationOverride(e.target.value)}
                placeholder="Organization name"
                className="input text-sm"
                disabled={disabled || generating}
              />
            </div>
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
