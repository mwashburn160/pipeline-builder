import { useState, useImperativeHandle, forwardRef, useId } from 'react';
import { Sparkles } from 'lucide-react';
import type { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import api from '@/lib/api';
import { isAskAgentProvider } from '@/lib/ai-constants';
import { streamAgentDraft } from '@/lib/ask-agent-draft';
import { AI_MAX_PROMPT_LENGTH, formatJSON } from '@/lib/constants';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import { GeneratedConfigReview, GenerationProgress, stageProgress, useGeneratedProps } from '@/components/pipeline/GeneratedConfigReview';

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

/**
 * Pipeline-create mode that generates a full pipeline configuration from a
 * free-text prompt via `POST /api/pipelines/generate/stream` (SSE). Mirrors the
 * plugin prompt builder's UX and shares GitUrlTab's review (GeneratedConfigReview),
 * but drives the prompt endpoint instead of repo analysis.
 */
const PromptGenerateTab = forwardRef<PromptGenerateTabRef, PromptGenerateTabProps>(
  ({ disabled }, ref) => {
    const uid = useId();
    const [prompt, setPrompt] = useState('');
    const [generatedProps, setGeneratedProps] = useState<BuilderProps | null>(null);
    const [stageCount, setStageCount] = useState(0);
    const [generatedDescription, setGeneratedDescription] = useState('');
    const [generatedKeywords, setGeneratedKeywords] = useState('');
    const [projectOverride, setProjectOverride] = useState('');
    const [organizationOverride, setOrganizationOverride] = useState('');

    const ai = useAIProviders(() => api.getAIProviders(), { askAgent: true });
    const { generating, error, preview: previewJson, setError, setPreview: setPreviewJson, generate } = useAiStreamGeneration();

    const { onPluginChange, withOverrides } = useGeneratedProps({
      generatedProps, setGeneratedProps, setPreviewJson, projectOverride, organizationOverride,
    });

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        const props = withOverrides();
        if (!props) setError('Generate a configuration first using the button above.');
        return props;
      },
      getDescription: () => generatedDescription,
      getKeywords: () => generatedKeywords,
    }));

    // Set on unmount (e.g. the create modal closes mid-generation) so the async
    // stream loop stops consuming + stops calling setState on a dead component.
    const cancelledRef = useUnmountedRef();

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
        stream: isAskAgentProvider(ai.selectedProvider)
          ? streamAgentDraft('pipeline', prompt.trim(), ai.selectedModel)
          : api.streamPipelineFromPrompt(prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse),
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
          <span className="text-sm text-fg-muted">Loading AI providers...</span>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <AiProviderModelPicker ai={ai} disabled={disabled || generating} />

        {/* Prompt Input */}
        <div>
          <label className="label" htmlFor={`${uid}-describe-your-pipeline`}>Describe your pipeline</label>
          <Textarea
            id={`${uid}-describe-your-pipeline`}
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setError(null); }}
            placeholder={'Example: "A CI/CD pipeline for a Node.js API: install deps, run unit tests, build a Docker image, then deploy to staging on the main branch."'}
            rows={4}
            className="text-sm"
            disabled={disabled || generating}
            maxLength={AI_MAX_PROMPT_LENGTH}
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-fg-muted">
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

        {generating && !previewJson && (
          <GenerationProgress title="Generating pipeline configuration..." detail={stageProgress(stageCount)} />
        )}

        {/* Error */}
        <ErrorAlert message={error || ai.error} />

        <GeneratedConfigReview
          generatedProps={generatedProps}
          previewJson={previewJson}
          generating={generating}
          disabled={disabled}
          projectOverride={projectOverride}
          setProjectOverride={setProjectOverride}
          organizationOverride={organizationOverride}
          setOrganizationOverride={setOrganizationOverride}
          onPluginChange={onPluginChange}
          regenerateHint="or refine your prompt and regenerate."
        />
      </div>
    );
  },
);

PromptGenerateTab.displayName = 'PromptGenerateTab';
export default PromptGenerateTab;
