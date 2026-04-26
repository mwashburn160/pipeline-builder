// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  shouldShowOnboarding,
  buildSteps,
  completedCount,
  dismissKey,
  visitedPluginsKey,
  type OnboardingSignals,
} from '../src/lib/onboarding';

const signals = (overrides: Partial<OnboardingSignals> = {}): OnboardingSignals => ({
  visitedPlugins: false,
  pipelineCount: 0,
  executionCount: 0,
  ...overrides,
});

describe('shouldShowOnboarding', () => {
  it('shows for a fresh org (no signals, not dismissed)', () => {
    expect(shouldShowOnboarding(signals(), false)).toBe(true);
  });

  it('hides when user has dismissed', () => {
    expect(shouldShowOnboarding(signals(), true)).toBe(false);
  });

  it('hides once both pipeline AND execution exist (user is past onboarding)', () => {
    expect(shouldShowOnboarding(signals({ pipelineCount: 1, executionCount: 1 }), false)).toBe(false);
  });

  it('still shows when only pipelines exist but no executions yet (mid-onboarding)', () => {
    expect(shouldShowOnboarding(signals({ pipelineCount: 1, executionCount: 0 }), false)).toBe(true);
  });

  it('still shows when executions exist but no pipelines (anomalous — keep nudging)', () => {
    expect(shouldShowOnboarding(signals({ pipelineCount: 0, executionCount: 5 }), false)).toBe(true);
  });

  it('hides when dismissed even if user has no pipelines', () => {
    expect(shouldShowOnboarding(signals(), true)).toBe(false);
  });
});

describe('buildSteps', () => {
  it('returns three steps with stable ids', () => {
    const steps = buildSteps(signals());
    expect(steps.map((s) => s.id)).toEqual(['explore-plugins', 'create-pipeline', 'run-build']);
  });

  it('marks explore-plugins done when visited', () => {
    const steps = buildSteps(signals({ visitedPlugins: true }));
    expect(steps[0]?.done).toBe(true);
    expect(steps[1]?.done).toBe(false);
    expect(steps[2]?.done).toBe(false);
  });

  it('marks create-pipeline done when pipelineCount > 0', () => {
    const steps = buildSteps(signals({ pipelineCount: 1 }));
    expect(steps[1]?.done).toBe(true);
  });

  it('marks run-build done when executionCount > 0', () => {
    const steps = buildSteps(signals({ executionCount: 1 }));
    expect(steps[2]?.done).toBe(true);
  });

  it('all three done when all signals are present', () => {
    const steps = buildSteps(signals({ visitedPlugins: true, pipelineCount: 1, executionCount: 1 }));
    expect(steps.every((s) => s.done)).toBe(true);
  });

  it('every step has a non-empty title and href', () => {
    for (const step of buildSteps(signals())) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.href.startsWith('/')).toBe(true);
    }
  });
});

describe('completedCount', () => {
  it('returns 0 for no completion', () => {
    expect(completedCount(buildSteps(signals()))).toBe(0);
  });

  it('returns 3 for full completion', () => {
    expect(completedCount(buildSteps(signals({
      visitedPlugins: true, pipelineCount: 5, executionCount: 99,
    })))).toBe(3);
  });

  it('counts partial progress', () => {
    expect(completedCount(buildSteps(signals({ visitedPlugins: true })))).toBe(1);
    expect(completedCount(buildSteps(signals({ visitedPlugins: true, pipelineCount: 1 })))).toBe(2);
  });
});

describe('storage keys', () => {
  it('dismissKey is org-scoped', () => {
    expect(dismissKey('org-a')).toContain('org-a');
    expect(dismissKey('org-a')).not.toBe(dismissKey('org-b'));
  });

  it('visitedPluginsKey is org-scoped', () => {
    expect(visitedPluginsKey('org-a')).toContain('org-a');
    expect(visitedPluginsKey('org-a')).not.toBe(visitedPluginsKey('org-b'));
  });

  it('dismissKey and visitedPluginsKey use distinct namespaces', () => {
    expect(dismissKey('org-a')).not.toBe(visitedPluginsKey('org-a'));
  });
});
