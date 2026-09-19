// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { KeyRound } from 'lucide-react';
import { Callout } from './Callout';
import { SecretActions } from './SecretActions';

interface SecretRevealProps {
  value: string;
  label?: string;
  /** Override the "won't be shown again" note. */
  note?: string;
  /** Download filename for the secret. */
  filename?: string;
  /**
   * Dismiss the panel. Given one, the box also carries the "I've saved it"
   * acknowledgement — the same contract the recovery-codes sheet has, and for
   * the same reason: this value cannot be retrieved again, so it should take a
   * deliberate act to make it disappear rather than the next render.
   */
  onDone?: () => void;
  className?: string;
}

/**
 * A one-time "copy your secret now" box for a freshly-minted token/key — the
 * value in a monospace field, plus copy / download / acknowledge, wrapped in a
 * warning that it won't be shown again. Replaces the amber box duplicated
 * verbatim in the PAT section, incident webhook-token section, and the tokens
 * page; the action row is shared with {@link RecoveryCodes} via SecretActions.
 */
export function SecretReveal({
  value,
  label = 'Secret',
  note = "Copy it now — it won't be shown again.",
  filename = 'pipeline-builder-secret.txt',
  onDone,
  className,
}: SecretRevealProps) {
  return (
    <Callout variant="warning" icon={KeyRound} title={`${label} created`} className={className}>
      <p>{note}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-mono text-xs text-[var(--pb-text)] dark:border-amber-900/60 dark:bg-gray-900">
          {value}
        </code>
      </div>
      <SecretActions
        className="mt-2"
        text={value}
        filename={filename}
        fileHeader={`Pipeline Builder — ${label}\n\nThis value is shown once and stored only as a hash. Keep it somewhere safe.`}
        onDone={onDone}
      />
    </Callout>
  );
}
