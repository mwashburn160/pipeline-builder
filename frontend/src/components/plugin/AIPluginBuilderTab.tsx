import { useState, useEffect, useRef } from 'react';
import { Sparkles, Rocket, XCircle } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import { useBuildStatus } from '@/hooks/useBuildStatus';
import api from '@/lib/api';
import { AI_MAX_PROMPT_LENGTH, formatError, formatJSON } from '@/lib/constants';

/** Props for the AIPluginBuilderTab component. */
interface AIPluginBuilderTabProps {
  /** Whether the current user can upload public plugins (admin only). */
  canUploadPublic: boolean;
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
  /** Callback when a plugin is successfully deployed. */
  onCreated: () => void;
  /** Callback to close the parent modal. */
  onClose: () => void;
}

/** Shape of the AI-generated plugin configuration (without Dockerfile). */
interface GeneratedConfig {
  name: string;
  description?: string;
  version: string;
  pluginType: string;
  computeType: string;
  keywords: string[];
  primaryOutputDirectory?: string;
  installCommands: string[];
  commands: string[];
  env?: Record<string, string>;
}

/** AI-powered plugin builder that generates config and Dockerfile from a natural language prompt. */
export default function AIPluginBuilderTab({ canUploadPublic, disabled, onCreated, onClose }: AIPluginBuilderTabProps) {
  const [prompt, setPrompt] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  // Generated output
  const [generatedConfig, setGeneratedConfig] = useState<GeneratedConfig | null>(null);
  const [generatedDockerfile, setGeneratedDockerfile] = useState<string | null>(null);

  // Access level
  const [access, setAccess] = useState<'public' | 'private'>('private');

  // Build queue tracking
  const [requestId, setRequestId] = useState<string | null>(null);
  const { status: buildStatus, events, lastEvent } = useBuildStatus(requestId);

  const ai = useAIProviders(() => api.getPluginAIProviders());
  const { generating, error, preview: streamPreview, setError, setPreview: setStreamPreview, generate } = useAiStreamGeneration();
  // Track mount state so the 2s auto-close timer never fires onClose after
  // the parent has already unmounted the tab (e.g. user clicked Cancel).
  const mountedRef = useRef<boolean>(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Auto-complete on successful build
  useEffect(() => {
    if (buildStatus === 'completed') {
      setSuccess(`Plugin "${generatedConfig?.name}" deployed successfully!`);
      onCreated();
      setTimeout(() => {
        if (!mountedRef.current) return;
        onClose();
      }, 2000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when buildStatus changes; other deps are stable callbacks
  }, [buildStatus]);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description of your plugin.');
      return;
    }
    if (!ai.selectedProvider || !ai.selectedModel) {
      setError('Please select a provider and model.');
      return;
    }
    setSuccess(null);
    setGeneratedConfig(null);
    setGeneratedDockerfile(null);

    const keyToUse = ai.customApiKey.trim() || undefined;

    await generate<{ config: GeneratedConfig; dockerfile: string }>({
      stream: api.streamPluginGeneration(prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse),
      onDone: (data) => {
        setGeneratedConfig(data.config);
        setGeneratedDockerfile(data.dockerfile);
        setStreamPreview(null);
      },
      onSettled: () => setStreamPreview(null),
    });
  };

  const handleDeploy = async () => {
    if (!generatedConfig || !generatedDockerfile) return;

    setError(null);
    setSuccess(null);
    setRequestId(null);
    setDeploying(true);

    try {
      const response = await api.deployGeneratedPlugin({
        ...generatedConfig,
        dockerfile: generatedDockerfile,
        accessModifier: access,
      });

      if (response.statusCode === 202 && response.data?.requestId) {
        // Build queued — start listening for SSE events
        setRequestId(response.data.requestId);
      } else if (response.success) {
        // Fallback: synchronous response
        setSuccess(`Plugin "${generatedConfig.name}" deployed successfully!`);
        onCreated();
        setTimeout(() => { if (mountedRef.current) onClose(); }, 2000);
      }
    } catch (err: unknown) {
      const message = formatError(err, 'Deployment failed');
      setError(message);
    } finally {
      setDeploying(false);
    }
  };

  const isBuilding = requestId !== null && buildStatus === 'building';
  const isWorking = generating || deploying || isBuilding;

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
      <AiProviderModelPicker ai={ai} disabled={disabled || isWorking} />

      {/* Prompt Input */}
      <div>
        <label className="label">Describe your plugin</label>
        <Textarea
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setError(null); }}
          placeholder={'Example: "A Node.js 20 build plugin that runs npm ci and npm run build. Should support TypeScript and output to the dist directory."'}
          rows={4}
          className="text-sm"
          disabled={disabled || isWorking}
          maxLength={AI_MAX_PROMPT_LENGTH}
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {prompt.length}/{AI_MAX_PROMPT_LENGTH} characters
          </p>
          <Button
            onClick={handleGenerate}
            disabled={disabled || isWorking || !prompt.trim()}
          >
            {generating ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 mr-2" />
                Generate Plugin
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Error */}
      <ErrorAlert message={error || ai.error} />

      {/* Success */}
      <SuccessAlert message={success} />

      {/* Build failure */}
      {buildStatus === 'failed' && lastEvent && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
          <p className="text-sm text-red-800 dark:text-red-300 flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {lastEvent.message}
          </p>
        </div>
      )}

      {/* Build progress log */}
      {requestId && events.length > 0 && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 max-h-48 overflow-y-auto">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Build Log</p>
          {events.map((event, i) => (
            <div key={i} className={`text-xs font-mono py-0.5 ${
              event.type === 'ERROR' ? 'text-red-600 dark:text-red-400' :
              event.type === 'COMPLETED' ? 'text-green-600 dark:text-green-400' :
              'text-gray-600 dark:text-gray-400'
            }`}>
              {event.message}
            </div>
          ))}
          {isBuilding && (
            <div className="flex items-center gap-2 mt-1 text-xs text-blue-600 dark:text-blue-400">
              <LoadingSpinner size="sm" /> Building Docker image...
            </div>
          )}
        </div>
      )}

      {/* Streaming Preview */}
      {generating && streamPreview && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label">Generating...</label>
            <span className="text-xs text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1">
              <LoadingSpinner size="sm" /> Streaming...
            </span>
          </div>
          <pre className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
            {streamPreview}
          </pre>
        </div>
      )}

      {/* Generated Output */}
      {generatedConfig && generatedDockerfile && (
        <div className="space-y-4">
          {/* Plugin Config Preview */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label">Generated Plugin Configuration</label>
              <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                Ready to deploy
              </span>
            </div>
            <pre className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
              {formatJSON(generatedConfig)}
            </pre>
          </div>

          {/* Dockerfile Preview */}
          <div>
            <label className="label">Generated Dockerfile</label>
            <pre className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
              {generatedDockerfile}
            </pre>
          </div>

          {/* Access Level + Deploy */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <div className="flex items-center justify-between">
              <FormField label="Access Level" hint={!canUploadPublic ? 'Only admins can create public plugins' : undefined}>
                <Select
                  value={access}
                  onChange={(e) => setAccess(e.target.value as 'public' | 'private')}
                  className="!w-auto"
                  disabled={isWorking || !canUploadPublic}
                >
                  <option value="private">Private (Organization only)</option>
                  {canUploadPublic && <option value="public">Public (Available to all)</option>}
                </Select>
              </FormField>

              <Button
                onClick={handleDeploy}
                disabled={disabled || isWorking}
              >
                {deploying || isBuilding ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    {isBuilding ? 'Building...' : 'Queueing build...'}
                  </>
                ) : (
                  <>
                    <Rocket className="w-4 h-4 mr-2" />
                    Deploy Plugin
                  </>
                )}
              </Button>
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              This will build a Docker image from the generated Dockerfile and save the plugin to your organization.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
