// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { ShieldCheck } from 'lucide-react';
import { Callout } from '@/components/ui/Callout';
import { SecretActions } from '@/components/ui/SecretActions';

/**
 * The one and only showing of a set of recovery codes.
 *
 * They are stored hashed, so this is genuinely the last time they exist in
 * readable form — which is why the panel is loud, offers both copy and download,
 * and makes the person acknowledge before it goes away rather than closing on
 * the next render. That action row is {@link SecretActions}, shared with every
 * other one-time secret the app reveals.
 */
export function RecoveryCodes({
  codes,
  onDone,
  title = 'Save your recovery codes',
}: {
  codes: string[];
  onDone: () => void;
  title?: string;
}) {
  const asText = codes.join('\n');

  return (
    <div className="space-y-3">
      <Callout variant="warning" icon={ShieldCheck} title={title}>
        Each code works once, and this is the only time they are shown. Store them
        somewhere you can reach <strong>without</strong> the device running your
        authenticator app — they are how you get back in if you lose it.
      </Callout>

      <ul
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] p-4 font-mono text-sm"
        aria-label="Recovery codes"
      >
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>

      <SecretActions
        text={asText}
        filename="pipeline-builder-recovery-codes.txt"
        fileHeader={'Pipeline Builder recovery codes\n\nEach code works once. Keep them somewhere you can reach without this device.'}
        onDone={onDone}
        doneLabel="I've saved them"
      />
    </div>
  );
}
