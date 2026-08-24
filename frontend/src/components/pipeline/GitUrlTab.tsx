import { useState, useEffect, useImperativeHandle, forwardRef, useCallback, useRef } from 'react';
import { GitBranch, ChevronDown, ChevronUp, Globe, Code, Package, Plug, CheckCircle, AlertCircle, Loader } from 'lucide-react';
import { BuilderProps, Plugin, GeneratedPluginRef, asGeneratedSynth, asGeneratedStages } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import { clearPluginCache } from '@/hooks/usePlugins';
import PluginNameCombobox from '@/components/pipeline/editors/PluginNameCombobox';
import api from '@/lib/api';
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

/** Analysis data returned by the backend analyzing event. */
interface RepoAnalysisData {
  owner: string;
  repo: string;
  provider: string;
  defaultBranch: string;
  projectType: string;
  languages: Record<string, number>;
  frameworks: string[];
  packageManager: string;
  hasDockerfile: boolean;
  hasCdkJson: boolean;
  description: string;
}

/** Plugin creation status returned by the backend creating-plugins event. */
interface PluginCreationStatus {
  creating: string[];
  existing: string[];
  builds: Array<{ name: string; requestId?: string; error?: string }>;
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

const GitUrlTab = forwardRef<GitUrlTabRef, GitUrlTabProps>(
  ({ disabled, initialUrl, autoGenerate }, ref) => {
    const [gitUrl, setGitUrl] = useState(initialUrl || '');
    const [repoToken, setRepoToken] = useState('');
    const [showPrivate, setShowPrivate] = useState(false);
    const [analyzing, setAnalyzing] = useState(false);
    const [analysis, setAnalysis] = useState<RepoAnalysisData | null>(null);
    const [generatedProps, setGeneratedProps] = useState<BuilderProps | null>(null);
    const [stageCount, setStageCount] = useState(0);
    const [generatedDescription, setGeneratedDescription] = useState('');
    const [generatedKeywords, setGeneratedKeywords] = useState('');
    const [checkingPlugins, setCheckingPlugins] = useState(false);
    const [pluginStatus, setPluginStatus] = useState<PluginCreationStatus | null>(null);
    const [projectOverride, setProjectOverride] = useState('');
    const [organizationOverride, setOrganizationOverride] = useState('');

    const ai = useAIProviders(() => api.getAIProviders());
    const { generating, error, preview: previewJson, setError, setPreview: setPreviewJson, generate } = useAiStreamGeneration();
    const autoGenAttemptedRef = useRef<boolean>(false);

    // Set on unmount (e.g. the create modal closes or the user switches tab
    // mid-generation) so the async SSE loop stops consuming events + stops
    // calling setState on a dead component, and the generator's abort/`finally`
    // fires (server-side git clone is torn down).
    const cancelledRef = useRef(false);
    useEffect(() => () => { cancelledRef.current = true; }, []);

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

    const handleGenerate = async () => {
      if (!gitUrl.trim()) {
        setError('Please enter a Git repository URL.');
        return;
      }
      if (!ai.selectedProvider || !ai.selectedModel) {
        setError('Please select a provider and model.');
        return;
      }

      setAnalyzing(true);
      setAnalysis(null);
      setGeneratedProps(null);
      setStageCount(0);
      setGeneratedDescription('');
      setGeneratedKeywords('');
      setCheckingPlugins(false);
      setPluginStatus(null);
      setProjectOverride('');
      setOrganizationOverride('');

      const keyToUse = ai.customApiKey.trim() || undefined;
      const tokenToUse = repoToken.trim() || undefined;

      await generate<{ props: BuilderProps; description?: string; keywords?: string[] }>({
        stream: api.streamPipelineFromUrl(gitUrl.trim(), ai.selectedProvider, ai.selectedModel, keyToUse, tokenToUse),
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
        onEvent: (event) => {
          switch (event.type) {
            case 'analyzing':
              setAnalyzing(true);
              break;
            case 'analyzed':
              setAnalyzing(false);
              if (event.data) {
                setAnalysis(event.data as RepoAnalysisData);
              }
              break;
            case 'checking-plugins':
              setCheckingPlugins(true);
              break;
            case 'creating-plugins':
              setCheckingPlugins(false);
              if (event.data) {
                setPluginStatus(event.data as PluginCreationStatus);
                clearPluginCache();
              }
              break;
          }
        },
        onSettled: () => setAnalyzing(false),
      });
    };

    // Auto-generate when initialUrl + autoGenerate are set. Fire exactly once
    // when both provider and model become non-empty AND providers finish loading;
    // the ref guard prevents repeat triggers on later renders (e.g. user
    // toggling the provider dropdown).
    useEffect(() => {
      if (
        autoGenerate &&
        initialUrl &&
        ai.selectedProvider &&
        ai.selectedModel &&
        !ai.loading &&
        !autoGenAttemptedRef.current
      ) {
        autoGenAttemptedRef.current = true;
        handleGenerate();
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally skip initialUrl/autoGenerate/handleGenerate to prevent infinite loops on prop changes
    }, [ai.loading, ai.selectedProvider, ai.selectedModel]);

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
        {/* Git URL Input */}
        <div>
          <label className="label">Git Repository URL</label>
          <Input
            type="text"
            value={gitUrl}
            onChange={(e) => { setGitUrl(e.target.value); setError(null); setAnalysis(null); }}
            placeholder="https://github.com/owner/repo"
            className="text-sm"
            disabled={disabled || generating}
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Supports GitHub, GitLab, Bitbucket, and self-hosted Git URLs.
          </p>
        </div>

        {/* Private repo token (collapsible) */}
        <div>
          <button
            type="button"
            onClick={() => setShowPrivate(!showPrivate)}
            aria-expanded={showPrivate}
            className="flex items-center text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          >
            {showPrivate ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
            Private repository?
          </button>
          {showPrivate && (
            <div className="mt-2">
              <Input
                type="password"
                autoComplete="off"
                value={repoToken}
                onChange={(e) => setRepoToken(e.target.value)}
                placeholder="Personal access token for private repos"
                className="text-sm"
                disabled={disabled || generating}
              />
            </div>
          )}
        </div>

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
          <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 flex items-center gap-3">
            <LoadingSpinner size="sm" />
            <div>
              <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                {analyzing ? 'Analyzing repository structure...' : 'Generating pipeline configuration...'}
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
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

        {/* Analysis Badges */}
        {analysis && (
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Globe className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {analysis.owner}/{analysis.repo}
              </span>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                ({analysis.provider}) · {analysis.defaultBranch}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {analysis.projectType !== 'unknown' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300">
                  <Code className="w-3 h-3" />
                  {analysis.projectType}
                </span>
              )}
              {analysis.packageManager !== 'unknown' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                  <Package className="w-3 h-3" />
                  {analysis.packageManager}
                </span>
              )}
              {analysis.frameworks.map((fw) => (
                <span key={fw} className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                  {fw}
                </span>
              ))}
              {Object.entries(analysis.languages).slice(0, 3).map(([lang, pct]) => (
                <span key={lang} className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                  {lang} {pct}%
                </span>
              ))}
              {analysis.hasDockerfile && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-cyan-100 dark:bg-cyan-900/30 text-cyan-800 dark:text-cyan-300">
                  Docker
                </span>
              )}
              {analysis.hasCdkJson && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300">
                  AWS CDK
                </span>
              )}
            </div>
            {analysis.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{analysis.description}</p>
            )}
          </div>
        )}

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
          <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4">
            <div className="flex items-center gap-2">
              <Loader className="w-4 h-4 text-blue-500 animate-spin" />
              <span className="text-sm text-blue-700 dark:text-blue-300 font-medium">Checking referenced plugins...</span>
            </div>
          </div>
        )}
        {pluginStatus && (
          <div className="rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Plug className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Plugin Status</span>
            </div>
            {pluginStatus.existing.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pluginStatus.existing.map((name) => (
                  <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                    <CheckCircle className="w-3 h-3" />
                    {name}
                  </span>
                ))}
              </div>
            )}
            {pluginStatus.creating.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Auto-creating missing plugins:</p>
                <div className="flex flex-wrap gap-2">
                  {pluginStatus.builds.map((b) => (
                    <span
                      key={b.name}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                        b.error
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
                          : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300'
                      }`}
                    >
                      {b.error ? <AlertCircle className="w-3 h-3" /> : <Loader className="w-3 h-3 animate-spin" />}
                      {b.name}
                      {b.error && <span className="text-[10px] opacity-75 ml-1">({b.error})</span>}
                    </span>
                  ))}
                </div>
                {pluginStatus.builds.some((b) => !b.error) && (
                  <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                    Plugin builds started — they&apos;ll be ready shortly. You can create the pipeline now.
                  </p>
                )}
              </div>
            )}
            {pluginStatus.creating.length === 0 && pluginStatus.existing.length > 0 && (
              <p className="text-xs text-green-600 dark:text-green-400">All referenced plugins already exist.</p>
            )}
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
