/**
 * @module components/pipeline/AIBuilderTab
 * @description AI builder tab for the Create Pipeline modal.
 *
 * Provides a natural language prompt input and provider/model selection
 * for generating pipeline configurations (BuilderProps) via the AI SDK.
 * Uses {@link useAIProviders} for provider fetch/merge logic and
 * {@link useImperativeHandle} to expose generated props to the parent modal.
 */

import { useState, useImperativeHandle, forwardRef } from 'react';
import { Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useAIProviders } from '@/hooks/useAIProviders';
import api from '@/lib/api';
import { AI_MAX_PROMPT_LENGTH } from '@/lib/constants';

/** Methods exposed to the parent modal via ref. */
export interface AIBuilderTabRef {
  /** Returns generated BuilderProps, or null if not yet generated. */
  getProps: () => Promise<BuilderProps | null>;
  /** Returns the AI-generated description string. */
  getDescription: () => string;
  /** Returns the AI-generated keywords as a comma-separated string. */
  getKeywords: () => string;
}

/** Props for the AIBuilderTab component. */
interface AIBuilderTabProps {
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
}

const AIBuilderTab = forwardRef<AIBuilderTabRef, AIBuilderTabProps>(
  ({ disabled }, ref) => {
    const [prompt, setPrompt] = useState('');
    const [generating, setGenerating] = useState(false);
    const [generatedProps, setGeneratedProps] = useState<BuilderProps | null>(null);
    const [generatedDescription, setGeneratedDescription] = useState('');
    const [generatedKeywords, setGeneratedKeywords] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [previewJson, setPreviewJson] = useState<string | null>(null);

    const ai = useAIProviders(() => api.getAIProviders());

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        if (generatedProps) return generatedProps;
        setError('Generate a configuration first using the button below.');
        return null;
      },
      getDescription: () => generatedDescription,
      getKeywords: () => generatedKeywords,
    }));

    const handleGenerate = async () => {
      if (!prompt.trim()) {
        setError('Please enter a description of your pipeline.');
        return;
      }
      if (!ai.selectedProvider || !ai.selectedModel) {
        setError('Please select a provider and model.');
        return;
      }
      setError(null);
      setGenerating(true);
      setGeneratedProps(null);
      setPreviewJson(null);
      setGeneratedDescription('');
      setGeneratedKeywords('');

      try {
        const keyToUse = ai.customApiKey.trim() || undefined;

        for await (const event of api.streamPipelineGeneration(
          prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse,
        )) {
          switch (event.type) {
            case 'partial':
              if (event.data) {
                setPreviewJson(JSON.stringify(event.data, null, 2));
              }
              break;
            case 'done':
              if (event.data) {
                const data = event.data as { props: BuilderProps; description?: string; keywords?: string[] };
                setGeneratedProps(data.props);
                setPreviewJson(JSON.stringify(data.props, null, 2));
                setGeneratedDescription(data.description || '');
                setGeneratedKeywords(Array.isArray(data.keywords) ? data.keywords.join(', ') : '');
              }
              break;
            case 'error':
              setError(event.message || 'Generation failed');
              break;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Generation failed';
        setError(message);
      } finally {
        setGenerating(false);
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

    if (ai.providers.length === 0) {
      return (
        <div className="rounded-xl bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-6 text-center">
          <p className="text-sm text-yellow-800 dark:text-yellow-300 font-medium">No AI providers configured</p>
          <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
            Configure an API key in Settings or set an environment variable on the pipeline service.
          </p>
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
                  {p.name} ({p.source})
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
            Use custom API key
          </button>
          {ai.showKeyOverride && (
            <div className="mt-2">
              <input
                type="password"
                value={ai.customApiKey}
                onChange={(e) => ai.setCustomApiKey(e.target.value)}
                placeholder={ai.currentSource === 'org' ? 'Leave empty to use organization key' : 'Leave empty to use server key'}
                className="input text-sm"
                disabled={disabled || generating}
              />
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Overrides the {ai.currentSource === 'org' ? 'organization' : 'server'} key for this request only.
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
            placeholder={'Example: "Build a Node.js app from my GitHub repo acme/my-app on the main branch. Use the nodejs-build plugin for synth. Add a test stage using the nodejs-test plugin and a deploy stage using the cdk-deploy plugin."'}
            rows={6}
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
                  Generate Configuration
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {(error || ai.error) && (
          <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
            <p className="text-sm text-red-800 dark:text-red-300">{error || ai.error}</p>
          </div>
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
              Review the configuration above. Click &quot;Create&quot; to submit, or regenerate with a different prompt.
            </p>
          </div>
        )}
      </div>
    );
  },
);

AIBuilderTab.displayName = 'AIBuilderTab';
export default AIBuilderTab;
