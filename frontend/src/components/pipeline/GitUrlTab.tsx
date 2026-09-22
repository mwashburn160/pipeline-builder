import { useImperativeHandle, forwardRef, useId } from 'react';
import { GitBranch, Loader } from 'lucide-react';
import type { BuilderProps } from '@/types';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { useRepoAnalysis } from '@/hooks/internal/useRepoAnalysis';
import { PrivateRepoFields } from '@/components/pipeline/PrivateRepoFields';
import { AnalysisResultPanel, PluginStatusPanel } from '@/components/pipeline/AnalysisResultPanel';
import { GeneratedConfigReview, GenerationProgress, stageProgress, useGeneratedProps } from '@/components/pipeline/GeneratedConfigReview';

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

const GitUrlTab = forwardRef<GitUrlTabRef, GitUrlTabProps>(
  ({ disabled, initialUrl, autoGenerate }, ref) => {
    const uid = useId();
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

    const { onPluginChange, withOverrides } = useGeneratedProps({
      generatedProps, setGeneratedProps, setPreviewJson, projectOverride, organizationOverride,
    });

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        const props = withOverrides();
        if (!props) setError('Generate a configuration first using the button below.');
        return props;
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
          <label className="label" htmlFor={`${uid}-git-repository-url`}>Git repository URL</label>
          <Input
            id={`${uid}-git-repository-url`}
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

        {generating && !previewJson && (
          <GenerationProgress
            title={analyzing ? 'Analyzing repository structure...' : 'Generating pipeline configuration...'}
            detail={analyzing ? 'Scanning files, languages, and frameworks' : stageProgress(stageCount)}
          />
        )}

        {/* Error */}
        <ErrorAlert message={error || ai.error} />

        {analysis && <AnalysisResultPanel analysis={analysis} />}

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
          regenerateHint="or regenerate with a different URL."
        >
          {checkingPlugins && (
            <div className="rounded-xl bg-info-bg border border-info-border p-4">
              <div className="flex items-center gap-2">
                <Loader className="w-4 h-4 text-brand animate-spin" />
                <span className="text-sm text-info-strong font-medium">Checking referenced plugins...</span>
              </div>
            </div>
          )}
          {pluginStatus && <PluginStatusPanel status={pluginStatus} />}
        </GeneratedConfigReview>
      </div>
    );
  },
);

GitUrlTab.displayName = 'GitUrlTab';
export default GitUrlTab;
