import { useState, useEffect, useId } from 'react';
import { Sparkles, Rocket } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { VisibilitySelect, visibilityHint } from '@/components/ui/VisibilitySelect';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { WarningAlert } from '@/components/ui/WarningAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import { useBuildStatus } from '@/hooks/useBuildStatus';
import { BuildFailureMessage } from './BuildFailureMessage';
import api from '@/lib/api';
import { isAskAgentProvider } from '@/lib/ai-constants';
import { streamAgentDraft } from '@/lib/ask-agent-draft';
import { AI_MAX_PROMPT_LENGTH, formatError, formatJSON } from '@/lib/constants';
import type { PluginGenerationDone, SimilarPlugin, Visibility } from '@/types';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import { useAutoCloseTimer } from '@/hooks/useAutoCloseTimer';

/** Props for the AIPluginBuilderTab component. */
interface AIPluginBuilderTabProps {
  /** `plugins:publish` — required for the `public` rung of the visibility ladder. */
  canPublish: boolean;
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

/**
 * "Similar plugins already exist" hint from the generator's catalog lookup:
 * nudges the user to reuse an existing plugin instead of deploying a duplicate.
 * Renders nothing when the list is empty.
 */
export function SimilarPluginsNotice({ plugins }: { plugins: SimilarPlugin[] }) {
  if (plugins.length === 0) return null;
  return (
    <WarningAlert
      message={
        <>
          Similar plugins already exist:{' '}
          {plugins.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <span className="font-mono font-medium">{p.name}</span>
              {p.category && <span className="text-xs"> ({p.category})</span>}
            </span>
          ))}
          . Consider reusing one of them instead of deploying a duplicate.
        </>
      }
    />
  );
}

/**
 * The catalog's Dockerfile rules the generated Dockerfile breaks (the same
 * static checks `test-plugins.sh` and `pipeline-manager plugin validate` run).
 * Deploying still works — the build doesn't enforce them — but the plugin
 * can't be listed in the directory until they're fixed.
 */
export function DockerfileViolationsNotice({ violations }: { violations: string[] }) {
  if (violations.length === 0) return null;
  return (
    <WarningAlert
      message={
        <>
          The generated Dockerfile breaks {violations.length === 1 ? 'a catalog rule' : `${violations.length} catalog rules`}:
          <ul className="list-disc ml-5 mt-1 space-y-0.5">
            {violations.map((v) => <li key={v} className="text-xs">{v}</li>)}
          </ul>
          <span className="text-xs">Regenerate with a more specific prompt, or fix the Dockerfile before publishing it to the directory.</span>
        </>
      }
    />
  );
}

/** AI-powered plugin builder that generates config and Dockerfile from a natural language prompt. */
export default function AIPluginBuilderTab({ canPublish, disabled, onCreated, onClose }: AIPluginBuilderTabProps) {
  const uid = useId();
  const [prompt, setPrompt] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  // Generated output
  const [generatedConfig, setGeneratedConfig] = useState<GeneratedConfig | null>(null);
  const [generatedDockerfile, setGeneratedDockerfile] = useState<string | null>(null);
  const [similarPlugins, setSimilarPlugins] = useState<SimilarPlugin[]>([]);
  const [dockerfileViolations, setDockerfileViolations] = useState<string[]>([]);

  // Visibility — `org` is the backend's create default for plugins; `private` is opt-in.
  const [access, setAccess] = useState<Visibility>('org');

  // Build queue tracking
  const [requestId, setRequestId] = useState<string | null>(null);
  const { status: buildStatus, events, lastEvent } = useBuildStatus(requestId);

  const ai = useAIProviders(() => api.getPluginAIProviders(), { askAgent: true });
  const { generating, error, preview: streamPreview, setError, setPreview: setStreamPreview, generate } = useAiStreamGeneration();
  const unmountedRef = useUnmountedRef();
  const autoClose = useAutoCloseTimer();

  // Auto-complete on successful build
  useEffect(() => {
    if (buildStatus === 'completed') {
      setSuccess(`Plugin "${generatedConfig?.name}" deployed successfully!`);
      onCreated();
      setTimeout(() => {
        if (unmountedRef.current) return;
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
    setSimilarPlugins([]);
    setDockerfileViolations([]);

    const keyToUse = ai.customApiKey.trim() || undefined;

    await generate<PluginGenerationDone<GeneratedConfig>>({
      stream: isAskAgentProvider(ai.selectedProvider)
        ? streamAgentDraft('plugin', prompt.trim(), ai.selectedModel)
        : api.streamPluginGeneration(prompt.trim(), ai.selectedProvider, ai.selectedModel, keyToUse),
      onDone: (data) => {
        setGeneratedConfig(data.config);
        setGeneratedDockerfile(data.dockerfile);
        setSimilarPlugins(data.similarPlugins ?? []);
        setDockerfileViolations(data.dockerfileViolations ?? []);
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
        visibility: access,
      });

      if (response.statusCode === 202 && response.data?.requestId) {
        // Build queued — start listening for SSE events
        setRequestId(response.data.requestId);
      } else if (response.success) {
        // Fallback: synchronous response
        setSuccess(`Plugin "${generatedConfig.name}" deployed successfully!`);
        onCreated();
        autoClose.schedule(onClose, 2000);
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
        <span className="text-sm text-fg-muted">Loading AI providers...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AiProviderModelPicker ai={ai} disabled={disabled || isWorking} />

      {/* Prompt Input */}
      <div>
        <label className="label" htmlFor={`${uid}-describe-your-plugin`}>Describe your plugin</label>
        <Textarea
          id={`${uid}-describe-your-plugin`}
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setError(null); }}
          placeholder={'Example: "A Node.js 20 build plugin that runs npm ci and npm run build. Should support TypeScript and output to the dist directory."'}
          rows={4}
          className="text-sm"
          disabled={disabled || isWorking}
          maxLength={AI_MAX_PROMPT_LENGTH}
        />
        <div className="flex items-center justify-between mt-2">
          <p className="text-xs text-fg-muted">
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
      {buildStatus === 'failed' && lastEvent && <BuildFailureMessage event={lastEvent} />}

      {/* Build progress log */}
      {requestId && events.length > 0 && (
        <div className="rounded-lg border border-default bg-canvas p-3 max-h-48 overflow-y-auto">
          <p className="text-xs font-medium text-fg-muted mb-2">Build log</p>
          {events.map((event, i) => (
            <div key={i} className={`text-xs font-mono py-0.5 ${
              event.type === 'ERROR' ? 'text-danger' :
              event.type === 'COMPLETED' ? 'text-success' :
              'text-fg-muted'
            }`}>
              {event.message}
            </div>
          ))}
          {isBuilding && (
            <div role="status" className="flex items-center gap-2 mt-1 text-xs text-brand">
              <LoadingSpinner size="sm" label={null} /> Building Docker image...
            </div>
          )}
        </div>
      )}

      {/* Streaming Preview */}
      {generating && streamPreview && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="label">Generating...</span>
            <span className="text-xs text-brand font-medium flex items-center gap-1">
              <LoadingSpinner size="sm" /> Streaming...
            </span>
          </div>
          <pre className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
            {streamPreview}
          </pre>
        </div>
      )}

      {/* Announce the outcome of a long build/generation (the config + Dockerfile
          previews stay silent — they'd be read out in full). */}
      <p className="sr-only" role="status" aria-live="polite">
        {generating ? 'Generating plugin…' : isBuilding ? 'Building plugin image…' : generatedConfig ? 'Plugin generated — ready to deploy.' : ''}
      </p>

      {/* Generated Output */}
      {generatedConfig && generatedDockerfile && (
        <div className="space-y-4">
          <SimilarPluginsNotice plugins={similarPlugins} />
          <DockerfileViolationsNotice violations={dockerfileViolations} />

          {/* Plugin Config Preview */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="label" id={`${uid}-generated-config`}>Generated plugin configuration</span>
              {dockerfileViolations.length === 0 ? (
                <span className="text-xs text-success font-medium">
                  Ready to deploy
                </span>
              ) : (
                <span className="text-xs text-warning-strong font-medium">
                  Review the Dockerfile
                </span>
              )}
            </div>
            <pre aria-labelledby={`${uid}-generated-config`} className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
              {formatJSON(generatedConfig)}
            </pre>
          </div>

          {/* Dockerfile Preview */}
          <div>
            <span className="label" id={`${uid}-generated-dockerfile`}>Generated Dockerfile</span>
            <pre aria-labelledby={`${uid}-generated-dockerfile`} className="input font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto whitespace-pre">
              {generatedDockerfile}
            </pre>
          </div>

          {/* Access Level + Deploy */}
          <div className="border-t border-default pt-4">
            <div className="flex items-center justify-between">
              <FormField label="Visibility" hint={visibilityHint(canPublish, 'plugins:publish')}>
                <VisibilitySelect value={access} onChange={setAccess} canPublish={canPublish} disabled={isWorking} />
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
            <p className="mt-2 text-xs text-fg-muted">
              This will build a Docker image from the generated Dockerfile and save the plugin to your organization.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
