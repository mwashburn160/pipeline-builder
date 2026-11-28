// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Ref } from 'react';
import { AlertTriangle, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import { AIServedBy } from '@/components/ui/AIServedBy';
import { READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import { AskSources } from './AskSources';
import { EXAMPLES, type ChatMessage } from './ask-chat';
import type { Proposal } from './proposal';
import { ProposalCard } from './ProposalCard';

interface AskConversationProps {
  /** The scrolling transcript element (the panel keeps it pinned to the newest token). */
  scrollRef: Ref<HTMLDivElement>;
  messages: ChatMessage[];
  /** The turn's failure, shown under the transcript. */
  error: string | null;
  quotaBlocked: boolean;
  isReadOnly: boolean;
  /** No provider is listed and no key was pasted: say so before a turn is sent. */
  noProviderHint: boolean;
  commitAllowed: (p: Proposal) => boolean;
  onSend: (question: string) => void;
  onRate: (index: number, rating: 'up' | 'down', sources: string[]) => void;
  onCommit: (index: number) => void;
  onDismiss: (index: number) => void;
  onClose: () => void;
}

/** The Ask transcript: example prompts, the bubbles with their sources, ratings and proposals, and the turn's error. */
export function AskConversation({
  scrollRef, messages, error, quotaBlocked, isReadOnly, noProviderHint, commitAllowed, onSend, onRate, onCommit, onDismiss, onClose,
}: AskConversationProps) {
  return (
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
        {messages.length === 0 && (
          <div className="text-sm text-fg-muted space-y-3">
            <p>Ask how to use the platform — deployments, pipelines, plugins, billing, and more.</p>
            <div className="space-y-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => onSend(ex)}
                  disabled={quotaBlocked || isReadOnly}
                  title={isReadOnly ? READ_ONLY_REASON : undefined}
                  className="block w-full text-left px-3 py-2 rounded-lg border border-default hover:border-brand hover:text-brand transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl px-3 py-2 text-sm text-white'
                  : 'max-w-[95%] rounded-2xl px-3 py-2 text-sm bg-surface-muted text-fg'
              }
              style={m.role === 'user' ? { background: 'var(--pb-brand-solid)' } : undefined}
            >
              <div className="whitespace-pre-wrap break-words">
                {m.content}
                {m.pending && <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom animate-pulse bg-current opacity-60" />}
              </div>
              {m.sources && m.sources.length > 0 && (
                <AskSources sources={m.sources} onNavigate={onClose} />
              )}
              {m.role === 'assistant' && !m.pending && <AIServedBy servedBy={m.servedBy} usage={m.usage} toolUsage={m.toolUsage} aiCalls={m.slotsCharged} className="mt-1" />}
              {/* Whether the answer was any good — the one thing the turn
                  cannot tell us about itself, and the only signal for which
                  docs the assistant answers badly from. Shown once the answer
                  has settled, so it never appears beside a half-streamed
                  sentence. */}
              {m.role === 'assistant' && !m.pending && m.content && (
                <div className="mt-2 flex items-center gap-2">
                  {m.rated ? (
                    <span className="text-2xs text-fg-muted inline-flex items-center gap-1">
                      <Check className="w-3 h-3" aria-hidden="true" />
                      Thanks — noted.
                    </span>
                  ) : (
                    <>
                      <span className="text-2xs text-fg-muted">Was this helpful?</span>
                      <button
                        type="button"
                        onClick={() => onRate(i, 'up', (m.sources ?? []).map((s) => s.id))}
                        aria-label="This answer was helpful"
                        className="p-1 rounded text-fg-muted hover:text-success-strong transition-colors"
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRate(i, 'down', (m.sources ?? []).map((s) => s.id))}
                        aria-label="This answer was not helpful"
                        className="p-1 rounded text-fg-muted hover:text-danger transition-colors"
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              )}
              {m.proposal && (
                <ProposalCard
                  proposal={m.proposal}
                  status={m.proposalStatus}
                  error={m.proposalError}
                  commitAllowed={commitAllowed}
                  isReadOnly={isReadOnly}
                  onCommit={() => onCommit(i)}
                  onDismiss={() => onDismiss(i)}
                  onClose={onClose}
                />
              )}
            </div>
          </div>
        ))}

        {error && (
          <div className="flex items-start gap-2 text-sm text-danger">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Said BEFORE a turn is sent, not after one fails. With no provider
            configured the picker falls back to a catalog entry nobody chose,
            and sending produced an error naming that one vendor — which read
            as "Bedrock is broken" rather than "this deployment has no AI set
            up". `ai.loading` gates it so the empty state does not flash while
            the provider list is still being fetched. */}
        {noProviderHint && (
          <div className="flex items-start gap-2 text-sm text-fg-muted">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-warning" />
            <span>
              No AI provider is listed for your organization. Ask will try this deployment&apos;s
              default model, which needs no key. To use a specific vendor instead, paste a key
              under <strong>Model and repository access</strong> below.
            </span>
          </div>
        )}
      </div>
  );
}
