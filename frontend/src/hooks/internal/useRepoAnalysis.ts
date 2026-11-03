// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback, useRef } from 'react';
import type { BuilderProps } from '@/types';
import { useAIProviders } from '@/hooks/useAIProviders';
import { useAiStreamGeneration } from '@/hooks/useAiStreamGeneration';
import api from '@/lib/api';
import { isAskAgentProvider } from '@/lib/ai-constants';
import { streamAgentDraft } from '@/lib/ask-agent-draft';
import { formatError, formatJSON } from '@/lib/constants';
import { useUnmountedRef } from '../useUnmountedRef';
import { invalidate } from '@/lib/api-cache';
import type { AIServedByInfo, AIUsageInfo } from '@/components/ui/AIServedBy';

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

/**
 * The plugins a generated config references but the org lacks, from the stream's
 * `missing-plugins` event. A PROPOSAL: nothing has been created — the user picks
 * which `proposed` names to create, and `confirmMissingPlugins`
 * sends exactly those.
 */
export interface MissingPluginProposal {
  existing: string[];
  /** Missing, safe-named and not listed: placeholders the user may create. */
  proposed: string[];
  /** Missing but not creatable (a listed plugin's name, or an unsafe name), with why. */
  refused: Array<{ name: string; error: string }>;
}

/** What the confirmed creation did (`POST /pipelines/generate/missing-plugins`). */
export interface PluginCreationStatus {
  created: string[];
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
  const [missingPlugins, setMissingPlugins] = useState<MissingPluginProposal | null>(null);
  const [creatingPlugins, setCreatingPlugins] = useState(false);
  const [pluginStatus, setPluginStatus] = useState<PluginCreationStatus | null>(null);
  const [served, setServed] = useState<{ servedBy?: AIServedByInfo; usage?: AIUsageInfo } | null>(null);
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
    setMissingPlugins(null);
    setPluginStatus(null);
    setServed(null);
    setProjectOverride('');
    setOrganizationOverride('');

    const keyToUse = ai.customApiKey.trim() || undefined;
    const tokenToUse = repoToken.trim() || undefined;

    await generate<{ props: BuilderProps; description?: string; keywords?: string[]; servedBy?: AIServedByInfo; usage?: AIUsageInfo }>({
      // Via the Ask agent the repo is analyzed by its propose_pipeline_from_repo
      // tool (the adapter re-emits the analysis as `analyzed`); it drafts only.
      // Neither path creates plugins: the direct one PROPOSES the missing ones.
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
        setServed({ servedBy: data.servedBy, usage: data.usage });
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
          case 'missing-plugins':
            setCheckingPlugins(false);
            if (event.data) setMissingPlugins(event.data as MissingPluginProposal);
            break;
        }
      },
      onSettled: () => setAnalyzing(false),
    });
  }, [gitUrl, repoToken, ai.selectedProvider, ai.selectedModel, ai.customApiKey, generate, setError, setPreviewJson, cancelledRef]);

  /**
   * Create the placeholder plugins the user confirmed — only those names, and
   * only on this explicit action: a model's output never creates anything by
   * itself. The server re-checks each name and creates it as the user.
   */
  const confirmMissingPlugins = useCallback(async (names: string[]) => {
    if (names.length === 0) return;
    setCreatingPlugins(true);
    setError(null);
    try {
      const res = await api.createMissingPlugins(names);
      if (cancelledRef.current) return;
      if (res.data) setPluginStatus(res.data);
      setMissingPlugins(null);
      invalidate.plugins();
    } catch (err) {
      if (!cancelledRef.current) setError(formatError(err, 'Failed to create the plugins.'));
    } finally {
      if (!cancelledRef.current) setCreatingPlugins(false);
    }
  }, [setError, cancelledRef]);

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
    missingPlugins,
    creatingPlugins,
    confirmMissingPlugins,
    pluginStatus,
    servedBy: served?.servedBy,
    usage: served?.usage,
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
