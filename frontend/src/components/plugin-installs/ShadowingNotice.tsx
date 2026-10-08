// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { AlertTriangle } from 'lucide-react';
import { OFFICIAL_PUBLISHER_HANDLE } from '@/lib/plugin-installs';

/**
 * A plugin whose NAME overrides something the org would otherwise resolve, in
 * either of the two shapes the resolver allows:
 *
 *   listing     an own-org plugin over a catalog listing — unqualified
 *               references (`plugin: { name }`) take the org's, not the
 *               listing's. Naming the publisher matters, so it is shown.
 *   parent-org  a TEAM's plugin over its parent org's plugin of the same name.
 *               There is no listing and no publisher here, so the Official
 *               wording would be simply false — hence the separate copy.
 *
 * Shown on the plugin list/detail and next to the pipeline editor's picker;
 * `compact` is the one-line inline form.
 */
export function ShadowingNotice({
  name, publisher = OFFICIAL_PUBLISHER_HANDLE, kind = 'listing', compact = false,
}: { name: string; publisher?: string; kind?: 'listing' | 'parent-org'; compact?: boolean }) {
  const text = kind === 'parent-org' ? (
    <>
      Shadows the parent organization&apos;s <code className="font-mono">{name}</code>: pipelines in this team that
      reference <code className="font-mono">{name}</code> use this plugin, not the parent&apos;s.
    </>
  ) : (
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
      <span>
        {text}{' '}
        {kind === 'parent-org'
          // No publisher-qualified form reaches the parent's plugin — a rename
          // is the only way out, so don't offer a reference that cannot work.
          ? 'Rename one of them if both are meant to stay.'
          : <>Reference <code className="font-mono">{`{ publisher: ${publisher}, name: ${name} }`}</code> to use the Official one.</>}
      </span>
    </div>
  );
}
