// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import type { BuilderProps } from '@/types';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import api from '@/lib/api';
import { isAskAgentProvider } from '@/lib/ai-constants';
import { streamAgentDraft } from '@/lib/ask-agent-draft';
import { formatJSON } from '@/lib/constants';
import { useUnmountedRef } from '../useUnmountedRef';
import { invalidate } from '@/lib/api-cache';

/** Analysis data returned by the backend analyzing event. */
export interface RepoAnalysisData {
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
export interface PluginCreationStatus {
  creating: string[];
  existing: string[];
  builds: Array<{ name: string; requestId?: string; error?: string }>;
}

export interface UseRepoAnalysisOptions {
  /** Optional pre-filled Git URL (from dashboard home). */
  initialUrl?: string;
  /** If true, auto-starts generation once providers have loaded. */
  autoGenerate?: boolean;
}

/**
 * Everything behind "generate a pipeline from a Git URL": the form inputs, the
 * AI provider selection, the SSE generation run, and the analysis / plugin
 * status the stream reports along the way.
 *
 * This was thirteen `useState`s inline in `GitUrlTab`, which made the component
 * a 571-line mix of a long-running async protocol and its own markup.
 */
export function useRepoAnalysis({ initialUrl, autoGenerate }: UseRepoAnalysisOptions) {
  const [gitUrl, setGitUrl] = useState(initialUrl || '');
  const [repoToken, setRepoToken] = useState('');
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

  const ai = useAIProviders(() => api.getAIProviders(), { askAgent: true });
  const { generating, error, preview: previewJson, setError, setPreview: setPreviewJson, generate } = useAiStreamGeneration();

  // Set on unmount (e.g. the create modal closes or the user switches tab
  // mid-generation) so the async SSE loop stops consuming events + stops
  // calling setState on a dead component, and the generator's abort/`finally`
  // fires (server-side git clone is torn down).
  const cancelledRef = useUnmountedRef();

  /**
   * Typing a new URL invalidates whatever the last run found, so the URL setter
   * clears the previous error and analysis with it.
   */
  const changeGitUrl = useCallback((value: string) => {
    setGitUrl(value);
    setError(null);
    setAnalysis(null);
  }, [setError]);

  const runGenerate = useCallback(async () => {
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
      // Via the Ask agent the repo is analyzed by its propose_pipeline_from_repo
      // tool (the adapter re-emits the analysis as `analyzed`); it drafts only, so
      // unlike the direct path it never auto-creates missing plugins.
      stream: isAskAgentProvider(ai.selectedProvider)
        ? streamAgentDraft('pipeline-from-repo', gitUrl.trim(), ai.selectedModel, { repoToken: tokenToUse })
        : api.streamPipelineFromUrl(gitUrl.trim(), ai.selectedProvider, ai.selectedModel, keyToUse, tokenToUse),
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
              invalidate.plugins();
            }
            break;
        }
      },
      onSettled: () => setAnalyzing(false),
    });
  }, [gitUrl, repoToken, ai.selectedProvider, ai.selectedModel, ai.customApiKey, generate, setError, setPreviewJson]);

  // Auto-generate when initialUrl + autoGenerate are set. Fires exactly once,
  // when both provider and model are non-empty AND providers have finished
  // loading. `autoGenAttemptedRef` — not a trimmed dependency list — is what
  // makes it once-only, so the effect can depend on everything it reads: the
  // guard flips before the first call and short-circuits every later run.
  const autoGenAttemptedRef = useRef(false);
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
      void runGenerate();
    }
  }, [autoGenerate, initialUrl, ai.loading, ai.selectedProvider, ai.selectedModel, runGenerate]);

  return {
    gitUrl, setGitUrl: changeGitUrl,
    repoToken, setRepoToken,
    analyzing,
    analysis,
    generatedProps, setGeneratedProps,
    stageCount,
    generatedDescription,
    generatedKeywords,
    checkingPlugins,
    pluginStatus,
    projectOverride, setProjectOverride,
    organizationOverride, setOrganizationOverride,
    ai,
    generating,
    error,
    setError,
    previewJson, setPreviewJson,
    generate: runGenerate,
  };
}
