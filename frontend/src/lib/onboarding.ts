// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic for the new-org onboarding card. Visibility, step completion,
 * and dismiss-flag handling — all kept side-effect-free for unit testing.
 */

const DISMISS_KEY_PREFIX = 'pb-onboarding-dismissed';
const VISITED_PLUGINS_KEY_PREFIX = 'pb-onboarding-visited-plugins';

export interface OnboardingSignals {
  /** Did the user visit /dashboard/plugins at least once? */
  visitedPlugins: boolean;
  /** Number of pipelines the org has (any state). */
  pipelineCount: number;
  /** Total executions ever, across all pipelines. */
  executionCount: number;
  /** Runners the org has registered, when known (a run implies one). */
  runnerCount?: number;
}

interface OnboardingStep {
  id: 'explore-plugins' | 'create-pipeline' | 'install-runner' | 'run-build';
  title: string;
  description: string;
  href: string;
  done: boolean;
}

/** True when the onboarding card should render. */
export function shouldShowOnboarding(
  signals: OnboardingSignals,
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  // Hide once the user has both created and executed a pipeline — they're past onboarding.
  if (signals.pipelineCount > 0 && signals.executionCount > 0) return false;
  return true;
}

/**
 * True when the account is effectively empty — used to show the getting-started
 * onboarding to a NEW owner/admin (who otherwise lands on the org-admin home,
 * all cards empty on a brand-new account) rather than only to invited members.
 *
 * Stricter than {@link shouldShowOnboarding}: an owner graduates to the
 * org-admin home as soon as the org has ANY activity — a first pipeline, a
 * first execution, or a second member (someone was invited). `memberCount`
 * is `null` when unknown (not yet loaded / fetch failed) and treated as
 * non-blocking so the nudge still shows for a fresh account.
 */
export function isFreshAccount(
  signals: Pick<OnboardingSignals, 'pipelineCount' | 'executionCount'> & { memberCount: number | null },
  dismissed: boolean,
): boolean {
  if (dismissed) return false;
  if (signals.pipelineCount > 0 || signals.executionCount > 0) return false;
  if (signals.memberCount !== null && signals.memberCount > 1) return false;
  return true;
}

/** Settings → Organization → Pipeline runners (kept here, not imported, so this
 *  module stays free of the runner copy). */
const PIPELINE_RUNNERS_SETTINGS_HREF = '/dashboard/settings?tab=organization#pipeline-runners';

/** Compute the current step state. Every pipeline runs through a runner, so
 *  "Install a runner" comes before "Run your first pipeline". */
export function buildSteps(signals: OnboardingSignals): OnboardingStep[] {
  return [
    {
      id: 'explore-plugins',
      title: 'Explore the plugin catalog',
      description: '119 pre-built plugins for builds, tests, security scans, and deploys.',
      href: '/dashboard/plugins',
      done: signals.visitedPlugins,
    },
    {
      id: 'create-pipeline',
      title: 'Create your first pipeline',
      description: 'Paste a Git URL above, upload a config, or build one manually.',
      href: '/dashboard/pipelines',
      done: signals.pipelineCount > 0,
    },
    {
      id: 'install-runner',
      title: 'Install a runner',
      description: 'Every pipeline runs through a runner in its AWS account — one runner per account for your organization.',
      href: PIPELINE_RUNNERS_SETTINGS_HREF,
      done: (signals.runnerCount ?? 0) > 0 || signals.executionCount > 0,
    },
    {
      id: 'run-build',
      title: 'Run your first pipeline',
      description: 'Trigger a pipeline from the pipelines list to see it in action.',
      href: '/dashboard/pipelines',
      done: signals.executionCount > 0,
    },
  ];
}

/** Number of steps already completed. */
export function completedCount(steps: OnboardingStep[]): number {
  return steps.filter((s) => s.done).length;
}

/** sessionStorage / localStorage keys are scoped per orgId so onboarding
 * resurfaces if the user switches orgs. */
export function dismissKey(orgId: string): string {
  return `${DISMISS_KEY_PREFIX}:${orgId}`;
}
export function visitedPluginsKey(orgId: string): string {
  return `${VISITED_PLUGINS_KEY_PREFIX}:${orgId}`;
}
