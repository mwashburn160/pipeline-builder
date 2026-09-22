// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle } from 'lucide-react';
import { OFFICIAL_PUBLISHER_HANDLE } from '@/lib/plugin-installs';

/**
 * An own-org plugin whose name shadows an Official listing: unqualified
 * references (`plugin: { name }`) resolve to the org's plugin, not the Official
 * one. Shown on the plugin list/detail and next to the pipeline editor's
 * picker; `compact` is the one-line inline form.
 */
export function ShadowingNotice({
  name, publisher = OFFICIAL_PUBLISHER_HANDLE, compact = false,
}: { name: string; publisher?: string; compact?: boolean }) {
  const text = (
    <>
      Shadows the Official listing <span className="font-mono">{publisher}/{name}</span>: pipelines that reference{' '}
      <code className="font-mono">{name}</code> use this plugin.
    </>
  );
  if (compact) {
    return (
      <p role="note" data-testid="shadowing-notice" className="mt-1 flex items-start gap-1 text-xs text-warning-strong">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{text}</span>
      </p>
    );
  }
  return (
    <div role="note" data-testid="shadowing-notice" className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-strong">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{text} Reference <code className="font-mono">{`{ publisher: ${publisher}, name: ${name} }`}</code> to use the Official one.</span>
    </div>
  );
}
