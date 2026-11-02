// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';

/**
 * Whether a `PLUGIN_VULN_WAIVERS` exemption covers this plugin, and what it is.
 *
 * Shown in two places, for opposite reasons:
 *
 *   on a BLOCKED build — a waiver that silently fails to apply (expired, or
 *     naming a package other than the one actually failing) is indistinguishable
 *     from having no waiver, and leaves the author re-reading a CVE list
 *     wondering why the exemption they were told about did nothing;
 *
 *   on a version that PASSED — a build allowed through by a waiver otherwise
 *     looks exactly like a clean one. That is the more dangerous of the two:
 *     nobody goes looking for an exemption they cannot see, and it is the state
 *     that persists.
 *
 * Read-only. There is deliberately no control here to create or extend one — a
 * waiver makes the gate pass, so it belongs in deployment config under review,
 * not behind a button on the page showing its effect.
 *
 * A failed fetch renders nothing: this is context beside something already on
 * screen, and a second error about loading the context would bury it.
 *
 * Waivers are keyed by plugin NAME but apply only to plugins the system org
 * owns (the Official catalog) — a tenant's own plugin that happens to share a
 * name with an Official one is NOT covered, so the notice needs the plugin's
 * `orgId` and renders nothing unless it is the response's `systemOrgId`. A `*`
 * waiver covers every system-org plugin.
 */
export function VulnWaiverNotice({ pluginName, orgId, className = '' }: {
  pluginName?: string;
  /** The plugin's owning org. Absent = unknown, so no waiver is claimed. */
  orgId?: string | null;
  className?: string;
}) {
  const enabled = !!pluginName && !!orgId;
  const { data } = useFetch(
    (signal) => api.listVulnWaivers({ signal }),
    [pluginName, orgId],
    { enabled },
  );
  if (!enabled) return null;
  const systemOrgId = data?.data?.systemOrgId;
  if (!systemOrgId || orgId!.toLowerCase() !== systemOrgId.toLowerCase()) return null;
  const mine = (data?.data?.waivers ?? []).filter((w) => w.plugin === pluginName || w.allPlugins || w.plugin === '*');
  if (mine.length === 0) return null;
  return (
    <div className={`text-xs opacity-90 ${className}`} data-testid="vuln-waiver-notice">
      {mine.map((w) => (
        <p key={`${w.plugin}:${w.version ?? ''}:${w.expires}`}>
          {w.expired
            ? `A vulnerability exemption for ${w.packages.join(', ')} EXPIRED on ${w.expires.slice(0, 10)}, so these findings count again.`
            : `A vulnerability exemption is active for ${w.packages.join(', ')}${w.allPlugins || w.plugin === '*' ? ' (every Official plugin)' : ''}${w.version ? ` (version ${w.version} only)` : ''} until ${w.expires.slice(0, 10)}. Findings outside it still block.`}
        </p>
      ))}
    </div>
  );
}
