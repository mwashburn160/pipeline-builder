// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { LoadingSpinner } from '@/components/ui/Loading';
import { powProgress } from '@/lib/plugin-submissions/proof-of-work';
import type { PowPhase } from '@/lib/plugin-submissions/submit-flow';

const PHASE_TEXT: Record<PowPhase, string> = {
  challenge: 'Getting an anti-spam challenge…',
  solving: 'Solving the anti-spam challenge in your browser…',
  uploading: 'Uploading…',
};

/**
 * Progress for a proof-of-work-guarded call. Solving takes a few seconds of
 * this device's CPU, in place of a third-party captcha. The bar tracks the
 * EXPECTED work, so it can finish early or wait near the end.
 */
export function PowProgress({ phase, attempts, difficulty, action }: {
  phase: PowPhase;
  attempts: number;
  difficulty: number;
  /** What the work is for ("Reading your package", "Submitting"). */
  action: string;
}) {
  const pct = phase === 'solving' ? Math.round(powProgress(attempts, difficulty) * 100) : phase === 'uploading' ? 100 : 0;
  return (
    <div className="space-y-2 rounded-lg border border-default p-3" data-testid="pow-progress" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-fg">
        <LoadingSpinner size="sm" />
        <span className="font-medium">{action}</span>
        <span className="text-fg-muted">{PHASE_TEXT[phase]}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Anti-spam check"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {phase === 'solving' && attempts > 0 && (
        <p className="text-xs text-fg-subtle">{attempts.toLocaleString()} hashes tried</p>
      )}
    </div>
  );
}
