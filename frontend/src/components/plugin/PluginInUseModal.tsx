// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { VulnSeverityBadge } from '@/components/plugin/VulnSeverity';
import { ApiError } from '@/lib/api/errors';
import type { PluginVersionInUseDetails } from '@/lib/api/pipeline-security-types';

/** A delete / purge refused because pipelines still reference the version. */
export interface PluginInUseRefusal {
  name: string;
  version: string;
  message: string;
  details: PluginVersionInUseDetails;
}

/**
 * The 409 `PLUGIN_VERSION_IN_USE` (reason `in_use`) a plugin delete answers,
 * as a refusal the modal can show — or null for any other error (including
 * the `listed` variant, which a forced delete with step-up can override).
 */
export function pluginInUseRefusal(err: unknown, plugin: { name: string; version: string }): PluginInUseRefusal | null {
  if (!(err instanceof ApiError) || err.code !== 'PLUGIN_VERSION_IN_USE') return null;
  const details = (err.details ?? {}) as unknown as PluginVersionInUseDetails;
  if (details.reason !== 'in_use') return null;
  return { name: plugin.name, version: plugin.version, message: err.message, details };
}

/**
 * Why a plugin version can't be deleted: the pipelines that still use it (with
 * links to each one's Plugin security tab, where its upgrade lives), how
 * vulnerable the version is and the version to move them to. There is no
 * force: a version a pipeline references is never deleted out from under it.
 */
export function PluginInUseModal({ refusal, onClose }: { refusal: PluginInUseRefusal; onClose: () => void }) {
  const { details } = refusal;
  const pipelines = details.pipelines ?? [];
  const total = details.pipelineCount ?? pipelines.length;
  const others = Math.max(0, total - pipelines.length);
  const v = details.vulnerability;
  return (
    <Modal
      title="Plugin version in use"
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={<div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>}
    >
      <div className="space-y-4 text-sm" data-testid="plugin-in-use">
        <p className="text-fg">
          <span className="font-mono">{refusal.name}@{refusal.version}</span> can&apos;t be deleted: {total} pipeline{total === 1 ? '' : 's'} still
          {total === 1 ? ' uses' : ' use'} it. Move {total === 1 ? 'it' : 'them'} to another version first.
        </p>
        {details.severity && (
          <div className="flex flex-wrap items-center gap-2">
            <VulnSeverityBadge grade={details.severity} />
            {v && (
              <span className="text-xs text-fg-muted">
                {v.kev > 0 && <span className="font-semibold text-danger-strong">{v.kev} KEV · </span>}
                {v.critical ?? v.criticalFixable ?? 0} Critical ({v.criticalFixable ?? 0} fixable) · {v.high ?? v.highFixable ?? 0} High ({v.highFixable ?? 0} fixable)
                {v.flagged ? ' · flagged by rescan' : ''}
              </span>
            )}
          </div>
        )}
        {details.suggestedVersion && (
          <p className="text-fg" data-testid="plugin-in-use-suggested">
            Suggested version: <span className="font-mono font-medium">{refusal.name}@{details.suggestedVersion}</span>
          </p>
        )}
        {pipelines.length > 0 && (
          <ul className="space-y-1" aria-label="Pipelines using this version">
            {pipelines.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Link href={`/dashboard/pipelines/${p.id}`} className="action-link">{p.name || p.id}</Link>
                  {p.sources?.map((s) => <Badge key={s} color="gray">{s}</Badge>)}
                  {p.deleted && <Badge color="yellow">deleted, still deployed</Badge>}
                </span>
                {!p.deleted && (
                  <Link href={`/dashboard/pipelines/${p.id}?tab=security`} className="action-link text-xs">Upgrade plugins →</Link>
                )}
              </li>
            ))}
          </ul>
        )}
        {others > 0 && (
          <p className="text-xs text-fg-muted">
            …and {others} more pipeline{others === 1 ? '' : 's'}
            {(details.orgCount ?? 1) > 1 ? ' in other organizations (their owners have been told)' : ''}.
          </p>
        )}
        <p className="text-xs text-fg-subtle">{refusal.message}</p>
      </div>
    </Modal>
  );
}
