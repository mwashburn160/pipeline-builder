// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { History, ExternalLink } from 'lucide-react';
import { CopyButton } from '@/components/ui/CopyButton';
import { Disclosure } from '@/components/ui/Disclosure';
import { buildAuditLogLink } from '@/lib/registry-audit-link';

export type RecentAction =
  | { kind: 'copy'; at: string; source: string; target: string; digest?: string; blobs?: number; isPromotion: boolean }
  | { kind: 'delete'; at: string; repo: string; ref: string; digest?: string };

interface RecentActionsPanelProps {
  actions: RecentAction[];
}

/**
 * Session-local ring buffer of the last N registry mutations performed
 * from this tab. Closes the loop after a promotion or delete by showing
 * the operator what they just did + the resolved digest, plus a deep-link
 * to Grafana Explore filtered to the corresponding audit event — so they
 * can verify the event landed without leaving Pipeline Builder.
 *
 * NOT persisted — refresh clears it. The authoritative source is the
 * structured audit log shipped via `emitAudit` in api-core.
 */
export function RecentActionsPanel({ actions }: RecentActionsPanelProps) {
  if (actions.length === 0) return null;

  return (
    <Disclosure
      className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50"
      summaryClassName="cursor-pointer list-none w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
      bodyClassName=""
      title={
        <>
          <History className="w-3.5 h-3.5" />
          <span>Recent actions ({actions.length})</span>
          <span className="ml-auto text-gray-400 font-normal">this session</span>
        </>
      }
    >
      <ul className="max-h-48 overflow-auto px-4 pb-2 space-y-1 text-xs">
        {actions.map((a, i) => {
            const auditHref = a.kind === 'copy'
              ? buildAuditLogLink({ kind: 'copy', at: a.at, digest: a.digest, source: a.source, target: a.target })
              : buildAuditLogLink({ kind: 'delete', at: a.at, digest: a.digest, repo: a.repo, ref: a.ref });
            return (
              <li key={i} className="flex items-start gap-2 py-1 border-t border-gray-200 dark:border-gray-800 first:border-t-0">
                <span className="text-gray-400 font-mono w-12 flex-shrink-0">
                  {new Date(a.at).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                {a.kind === 'copy' ? (
                  <span className="flex-1 break-all">
                    <span className={a.isPromotion ? 'text-yellow-700 dark:text-yellow-300 font-medium' : 'text-blue-700 dark:text-blue-300'}>
                      {a.isPromotion ? 'Promoted' : 'Copied'}
                    </span>{' '}
                    <span className="font-mono">{a.source}</span> → <span className="font-mono">{a.target}</span>
                    {a.blobs !== undefined && <span className="text-gray-500"> ({a.blobs} blobs)</span>}
                  </span>
                ) : (
                  <span className="flex-1 break-all">
                    <span className="text-red-700 dark:text-red-300">Deleted</span>{' '}
                    <span className="font-mono">{a.repo}:{a.ref}</span>
                  </span>
                )}
                {a.digest && (
                  <span className="flex-shrink-0">
                    <CopyButton text={a.digest} />
                  </span>
                )}
                {auditHref && (
                  <a
                    href={auditHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View this event in the audit log (Grafana Explore / Loki)"
                    aria-label="View in audit log"
                    className="flex-shrink-0 inline-flex items-center gap-0.5 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span className="hidden sm:inline">audit</span>
                  </a>
                )}
              </li>
            );
          })}
      </ul>
    </Disclosure>
  );
}
