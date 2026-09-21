// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Boxes } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { formatDateTime } from '@/lib/format';
import { PluginSupplyChain } from './PluginSupplyChain';

/**
 * Parse a Plugin URI of shape `<repo-path>:<tag>` (optionally prefixed with
 * a registry host like `registry.example.com/...`) into the repo path and
 * tag the registry browser uses. Strips a leading host segment if present.
 */
function parsePluginUri(uri: string | undefined): { repo: string; tag: string } | null {
  if (!uri) return null;
  const lastColon = uri.lastIndexOf(':');
  if (lastColon < 1) return null;
  let repo = uri.slice(0, lastColon);
  const tag = uri.slice(lastColon + 1);
  // Strip leading host (anything before the first `/` that contains a `.` or `:`).
  const firstSlash = repo.indexOf('/');
  if (firstSlash > 0) {
    const head = repo.slice(0, firstSlash);
    if (head.includes('.') || head.includes(':')) repo = repo.slice(firstSlash + 1);
  }
  if (!repo || !tag) return null;
  return { repo, tag };
}

/** Registry-browser deep link for a plugin image, or null when the URI doesn't parse. */
export function registryHrefFor(uri: string | undefined): string | null {
  const parsed = parsePluginUri(uri);
  return parsed
    ? `/dashboard/registry?repo=${encodeURIComponent(parsed.repo)}&tag=${encodeURIComponent(parsed.tag)}`
    : null;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="text-fg font-mono text-xs mt-0.5">{value}</p>
    </div>
  );
}

/**
 * Read-only plugin summary opened from the catalog's name link. Everything it
 * shows is on the list row — no extra fetch. `showRegistryLink` (sysadmins) adds
 * the jump to the image in the registry browser.
 */
export function PluginDetailModal({ plugin, showRegistryLink, onClose }: {
  plugin: PluginSummary;
  showRegistryLink: boolean;
  onClose: () => void;
}) {
  const registryHref = showRegistryLink ? registryHrefFor(plugin.uri) : null;
  return (
    <Modal title={plugin.name} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Detail label="Version" value={plugin.version} />
          <Detail label="Category" value={plugin.category || '—'} />
          <Detail label="Type" value={plugin.pluginType} />
          <Detail label="Compute" value={plugin.computeType} />
          <Detail label="Access" value={plugin.visibility} />
          <Detail label="Timeout" value={plugin.timeout ? `${plugin.timeout} min` : '—'} />
          <Detail label="Active" value={plugin.isActive ? 'Yes' : 'No'} />
          <Detail label="Default" value={plugin.isDefault ? 'Yes' : 'No'} />
        </div>
        {plugin.description && (
          <div>
            <p className="text-xs font-medium text-fg-muted mb-1">Description</p>
            <p className="text-fg">{plugin.description}</p>
          </div>
        )}
        {plugin.keywords && plugin.keywords.length > 0 && (
          <div>
            <p className="text-xs font-medium text-fg-muted mb-1">Keywords</p>
            <div className="flex flex-wrap gap-1">
              {plugin.keywords.map((k: string, i: number) => (
                <span key={`${k}-${i}`} className="px-2 py-0.5 rounded-full text-xs bg-surface-muted text-fg-muted">{k}</span>
              ))}
            </div>
          </div>
        )}
        {plugin.uri && (
          <div>
            <Detail label="URI" value={plugin.uri} />
            {registryHref && (
              <Link href={registryHref} className="action-link inline-flex items-center gap-1 mt-1 text-xs">
                <Boxes className="w-3.5 h-3.5" />
                Browse this image in the registry
              </Link>
            )}
          </div>
        )}
        <PluginSupplyChain plugin={plugin} />
        <div className="grid grid-cols-2 gap-3 text-xs text-fg-muted">
          <div>Created: {formatDateTime(plugin.createdAt)}</div>
          <div>Updated: {formatDateTime(plugin.updatedAt)}</div>
        </div>
      </div>
    </Modal>
  );
}
