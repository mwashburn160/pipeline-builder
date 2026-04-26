// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { CheckCircle2, Circle, Sparkles, X, ArrowRight } from 'lucide-react';
import {
  buildSteps,
  completedCount,
  type OnboardingSignals,
} from '@/lib/onboarding';

interface NewOrgWelcomeProps {
  signals: OnboardingSignals;
  /** Called when the user clicks "Don't show again". Persistence is handled by the parent. */
  onDismiss: () => void;
}

/**
 * 3-step onboarding card shown to fresh orgs (0 pipelines, 0 executions).
 * Steps auto-check from observed signals; no manual click needed.
 */
export function NewOrgWelcome({ signals, onDismiss }: NewOrgWelcomeProps) {
  const steps = buildSteps(signals);
  const done = completedCount(steps);

  return (
    <div className="card mb-4 border-indigo-200 dark:border-indigo-900 bg-gradient-to-br from-indigo-50/50 to-purple-50/50 dark:from-indigo-950/20 dark:to-purple-950/20">
      <div className="flex items-start gap-3 mb-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-indigo-600 flex items-center justify-center">
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Get started — {done}/3 done
            </h2>
            <button
              type="button"
              onClick={onDismiss}
              className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
              aria-label="Dismiss onboarding card"
            >
              <X className="w-3 h-3" aria-hidden="true" />
              Don&apos;t show again
            </button>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
            Three steps to your first build. Each checks off automatically as you go.
          </p>
        </div>
      </div>

      <ol className="space-y-2">
        {steps.map((step, idx) => {
          const Icon = step.done ? CheckCircle2 : Circle;
          const iconColor = step.done ? 'text-green-600 dark:text-green-400' : 'text-gray-300 dark:text-gray-600';
          return (
            <li key={step.id}>
              <Link
                href={step.href}
                className="flex items-start gap-3 p-3 rounded-md hover:bg-white/60 dark:hover:bg-gray-900/30 transition-colors group"
              >
                <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${iconColor}`} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-500">
                      Step {idx + 1}
                    </span>
                    <span className={`text-sm font-medium ${step.done ? 'text-gray-500 dark:text-gray-500 line-through' : 'text-gray-900 dark:text-gray-100'}`}>
                      {step.title}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                    {step.description}
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 flex-shrink-0 mt-1 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
