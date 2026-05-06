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
}

interface OnboardingStep {
  id: 'explore-plugins' | 'create-pipeline' | 'run-build';
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

/** Compute the current 3-step state. */
export function buildSteps(signals: OnboardingSignals): OnboardingStep[] {
  return [
    {
      id: 'explore-plugins',
      title: 'Explore the plugin catalog',
      description: '124 pre-built plugins for builds, tests, security scans, and deploys.',
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
      id: 'run-build',
      title: 'Run your first build',
      description: 'Trigger a pipeline from the pipelines list to see it in action.',
      href: '/dashboard/pipelines',
      done: signals.executionCount > 0,
    },
  ];
}

/** Number of steps already completed (0–3). */
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
