// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { CopyButton } from './CopyButton';

interface CodeBlockProps {
  code: string;
  /** Small language/label badge in the top-left (e.g. `bash`, `http`). */
  language?: string;
  /** Show a copy button (default true). */
  copyable?: boolean;
  className?: string;
}

/**
 * A dark, monospace command/endpoint block with an optional language badge and a
 * copy button — replaces the hand-rolled `<pre className="bg-gray-50 …">` blocks
 * (api-catalog auth snippet, incident webhook endpoints, CLI commands).
 */
export function CodeBlock({ code, language, copyable = true, className = '' }: CodeBlockProps) {
  return (
    <div className={['relative rounded-xl border border-[var(--pb-border)] bg-[var(--pb-surface-muted)]', className].filter(Boolean).join(' ')}>
      {(language || copyable) && (
        <div className="flex items-center justify-between border-b border-[var(--pb-border)] px-3 py-1.5">
          {language ? <span className="font-mono text-xs text-[var(--pb-text-muted)]">{language}</span> : <span />}
          {copyable && <CopyButton text={code} />}
        </div>
      )}
      <pre className="overflow-x-auto px-3 py-2.5 text-xs leading-relaxed text-[var(--pb-text)]">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

/** An inline route / code chip (e.g. `/api/billing`) — the monospace pill hand-rolled
 *  in api-catalog for gateway routes. */
export function EndpointChip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <code className={['inline-flex items-center rounded-md border border-[var(--pb-border)] bg-[var(--pb-surface-muted)] px-1.5 py-0.5 font-mono text-xs text-[var(--pb-text)]', className].filter(Boolean).join(' ')}>
      {children}
    </code>
  );
}
