// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { KeyRound } from 'lucide-react';
import { Callout } from './Callout';
import { CopyButton } from './CopyButton';

interface SecretRevealProps {
  value: string;
  label?: string;
  /** Override the "won't be shown again" note. */
  note?: string;
  className?: string;
}

/**
 * A one-time "copy your secret now" box for a freshly-minted token/key — the
 * value in a monospace field + a copy button, wrapped in a warning that it won't
 * be shown again. Replaces the amber box duplicated verbatim in the PAT section,
 * incident webhook-token section, and the tokens page.
 */
export function SecretReveal({ value, label = 'Secret', note = "Copy it now — it won't be shown again.", className }: SecretRevealProps) {
  return (
    <Callout variant="warning" icon={KeyRound} title={`${label} created`} className={className}>
      <p>{note}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-xs text-[var(--pb-text)] dark:border-amber-900/60 dark:bg-gray-900">
          {value}
        </code>
        <CopyButton text={value} />
      </div>
    </Callout>
  );
}
