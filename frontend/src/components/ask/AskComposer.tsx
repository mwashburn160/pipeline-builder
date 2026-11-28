// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { BookOpen, Send, Trash2 } from 'lucide-react';
import { AIQuotaHint } from '@/components/ui/AIQuotaHint';
import { ReadOnlyNotice, READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import type { AIQuota } from '@/hooks/useAIQuota';
import type { AIKeySource } from '@/lib/ai-quota';

interface AskComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: (question: string) => Promise<void>;
  /** End the conversation: drop the transcript (and any pending draft). */
  onClear: () => void;
  hasMessages: boolean;
  busy: boolean;
  quotaBlocked: boolean;
  isReadOnly: boolean;
  quota: AIQuota | null;
  keySource: AIKeySource;
  onClose: () => void;
}

/** The Ask question box: quota and read-only notices, the textarea and Send, Clear, and the help link. */
export function AskComposer({
  input, onInputChange, onSend, onClear, hasMessages, busy, quotaBlocked, isReadOnly, quota, keySource, onClose,
}: AskComposerProps) {
  return (
    <form
      className="mt-3 pt-3 border-t border-default"
      onSubmit={(e) => { e.preventDefault(); void onSend(input); }}
    >
      <ReadOnlyNotice show={isReadOnly} className="mb-2" />
      <AIQuotaHint quota={quota} keySource={keySource} className="mb-2" />
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          aria-label="Ask a question"
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onSend(input); }
          }}
          rows={2}
          placeholder={isReadOnly ? 'Unavailable in a read-only session' : 'Ask a question…'}
          disabled={busy || isReadOnly}
          title={isReadOnly ? READ_ONLY_REASON : undefined}
          className="flex-1 resize-none rounded-lg border border-default bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
        />
        <button
          type="submit"
          // A turn is POST /ask-agent/agent/stream, and `requireAuth` refuses every
          // non-GET under a read-only impersonation token — so the whole
          // assistant, documentation lookups included, is unavailable here.
          // Without this the composer accepted input and every send 403'd.
          disabled={busy || quotaBlocked || isReadOnly || !input.trim()}
          title={isReadOnly ? READ_ONLY_REASON : undefined}
          aria-label="Send"
          className="p-2 rounded-lg text-white disabled:opacity-40"
          style={{ background: 'var(--pb-brand-solid)' }}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-fg-muted">
        <span>Read-only · nothing is changed</span>
        <div className="flex items-center gap-3">
          {/* The transcript now outlives the drawer, so there has to be a way
              to end it. Without this, "start again" meant closing the panel —
              which no longer does anything. */}
          {hasMessages && (
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="inline-flex items-center gap-1 hover:text-brand disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          )}
          <Link href="/dashboard/help" onClick={onClose} className="inline-flex items-center gap-1 hover:text-brand">
            <BookOpen className="w-3.5 h-3.5" /> Browse all help
          </Link>
        </div>
      </div>
    </form>
  );
}
