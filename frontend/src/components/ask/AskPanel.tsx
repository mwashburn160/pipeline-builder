// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAIProviders } from '@/hooks/useAIProviders';
import api from '@/lib/api';
import type { AskSource, AskTurn } from '@/lib/api/domains/ask';
import { useFeatures } from '@/hooks/useFeatures';
import { AskHelpTopics } from './AskHelpTopics';
import { clearTranscript, getTranscriptEpoch, loadTranscript, saveTranscript } from './transcript-store';
import { formatAIError, streamEventError } from '@/lib/ai-errors';
import type { AIServedByInfo, AIUsageInfo } from '@/components/ui/AIServedBy';
import { useAIQuota } from '@/hooks/useAIQuota';
import { useAiDraftOutcome } from '@/hooks/useAiDraftOutcome';
import { aiKeySource, aiQuotaBlocked } from '@/lib/ai-quota';
import { useUnmountedRef } from '../../hooks/useUnmountedRef';
import type { Proposal } from './proposal';
import { persistable, type ChatMessage } from './ask-chat';
import { AskComposer } from './AskComposer';
import { AskConversation } from './AskConversation';
import { AskModelSettings } from './AskModelSettings';
import { useAskAvailability } from './useAskAvailability';
import { useProposalActions } from './useProposalActions';

/**
 * The "Ask" agent panel — a read-only, streaming chat grounded in the platform docs.
 * Opens from the topbar Ask action. v1 keeps conversation state client-side (the
 * transcript is sent back as history each turn); nothing is persisted or mutated.
 */
export function AskPanel({ onClose }: { onClose: () => void }) {
  // Committing a proposal calls the SAME create route the dashboard's own button
  // does (`plugins:write` for POST /plugins/deploy-generated, `pipelines:write`
  // for POST /pipelines, `templates:write` for POST /pipeline-templates), so the
  // entitlement that opens this panel is not enough to show its Create action.
  const { can, isReadOnly } = useAuthGuard();
  // Which assistant surface this DEPLOYMENT offers (ASK_UI_MODE via /config).
  // Runtime, because one prebuilt frontend image serves every deploy target.
  const { askUiMode } = useFeatures();
  // The stream has always accepted `provider` / `model` / `apiKey`; only the
  // pipeline and plugin AI tabs offered the choice. Same hook, same picker, so
  // the three surfaces stay identical — here the "server" providers are the ask-agent
  // service's own (`GET /ask-agent/providers`), merged with the org's saved keys and
  // the rest of the catalog (selectable with a key of your own).
  const ai = useAIProviders(api.getAskProviders);
  // Forwarded to the agent's repo-analysis tool, never shown to the model, and
  // held only for this panel's lifetime — it is what lets "draft me a pipeline
  // for <private repo>" work at all.
  const [repoToken, setRepoToken] = useState('');
  // Seeded from sessionStorage, so closing the drawer no longer discards the
  // conversation. The lazy initialiser matters: reading storage on every render
  // would be wasted work, and this must run before the first paint so the
  // transcript does not flash empty.
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadTranscript<ChatMessage>());
  // The session generation this panel's transcript belongs to. A logout or org
  // switch bumps it (and clears storage); this panel must then never write its
  // old conversation back. The layout remounts the panel on identity change.
  const epochRef = useRef(getTranscriptEpoch());
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The org's AI calls, read on open and after each turn, so "N left" is said
  // before a question is sent. A turn on the org's or a pasted key is not
  // charged, and an exhausted quota only blocks a turn on the platform's key.
  const { quota } = useAIQuota(busy);
  const keySource = aiKeySource(ai);
  const quotaBlocked = aiQuotaBlocked(quota?.summary, keySource);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on unmount (panel close) so the in-flight stream loop stops iterating and
  // stops calling setState on a dead component; stopping iteration also aborts the
  // underlying SSE fetch (streamRequest's AbortController runs in its `finally`).
  const cancelledRef = useUnmountedRef();
  // What became of each proposal, for the AI usage report's acceptance rate
  // (feature `agent`): Apply → accepted, Dismiss → discarded, a newer proposal or
  // closing the panel with one pending → discarded. The hook tracks ONE draft, so
  // the message it belongs to is remembered here: applying an older proposal
  // after a newer one arrived is not credited to the newer one.
  const draftOutcome = useAiDraftOutcome();
  const pendingDraftIndex = useRef<number | null>(null);

  // Persisted when the panel settles, NOT on every token: `patchLast` fires once
  // per streamed chunk, and serializing the transcript that often would burn the
  // main thread during the one moment the user is watching it render.
  useEffect(() => {
    if (busy) return;
    if (epochRef.current !== getTranscriptEpoch()) return;
    saveTranscript(persistable(messages));
  }, [messages, busy]);

  useEffect(() => {
    // Optional-chain the method: jsdom (and some older browsers) don't implement
    // Element.scrollTo — guard so streaming updates never throw in that environment.
    // `auto` (not `smooth`) avoids janky animation on every streamed token.
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, [messages]);

  const send = useCallback(async (raw: string) => {
    const query = raw.trim();
    // `isReadOnly` too: the turn is a POST that a read-only session is refused,
    // and the example prompts reach here without going through the composer.
    if (!query || busy || quotaBlocked || isReadOnly) return;
    setError(null);
    setInput('');

    // History = completed turns so far (exclude the new question).
    const history: AskTurn[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, content: m.content }));

    // Where this turn's assistant message will sit (after the question).
    const assistantIndex = messages.length + 1;
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: query },
      { role: 'assistant', content: '', pending: true },
    ]);
    setBusy(true);

    /** Update the last (assistant) message. */
    const patchLast = (patch: Partial<ChatMessage>) =>
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') next[next.length - 1] = { ...last, ...patch };
        return next;
      });

    // A provider the user (or the deployment) actually stands behind, as
    // opposed to whichever catalog entry happened to sort first.
    const providerChosen = !!ai.selectedProvider
      && (ai.currentSource !== 'none' || !!ai.customApiKey);

    try {
      let text = '';
      for await (const ev of api.askAgentStream(query, {
        history,
        // Omitted unless the picker resolved a REAL choice, so the service
        // falls back to its own default — the self-hosted model this deployment
        // runs on, which needs no key.
        //
        // `source: 'none'` is a catalog placeholder, not a selection: the list
        // is padded with every known provider so a user with their own key can
        // pick one. Sending one of those is how a deployment with nothing
        // configured ended up asking for Amazon Bedrock and getting
        // `AI provider "amazon-bedrock" is not configured` — the client naming a
        // vendor the user never chose, instead of letting the service answer
        // with its default. A placeholder IS a real choice once a key is typed
        // against it; that is the whole point of bringing your own vendor.
        ...(providerChosen ? { provider: ai.selectedProvider } : {}),
        ...(providerChosen && ai.selectedModel ? { model: ai.selectedModel } : {}),
        ...(ai.customApiKey ? { apiKey: ai.customApiKey } : {}),
        ...(repoToken.trim() ? { repoToken: repoToken.trim() } : {}),
      })) {
        if (cancelledRef.current) break; // panel closed — stop iterating (aborts the fetch)
        if (ev.type === 'sources') {
          patchLast({ sources: (ev.data as AskSource[]) ?? [] });
        } else if (ev.type === 'proposal') {
          patchLast({ proposal: ev.data as Proposal });
          draftOutcome.offered('agent', ev.data, ev.draftId);
          pendingDraftIndex.current = assistantIndex;
        } else if (ev.type === 'token') {
          text += String(ev.data ?? '');
          patchLast({ content: text });
        } else if (ev.type === 'done') {
          const done = (ev.data ?? {}) as { servedBy?: AIServedByInfo; usage?: AIUsageInfo; toolUsage?: AIUsageInfo; slotsCharged?: number };
          patchLast({ servedBy: done.servedBy, usage: done.usage, toolUsage: done.toolUsage, slotsCharged: done.slotsCharged });
        } else if (ev.type === 'error') {
          // Carries the code/status/Retry-After, so it reads like an HTTP failure would.
          throw streamEventError(ev, 'The assistant failed to respond.');
        }
      }
      if (!cancelledRef.current) {
        patchLast({ pending: false, content: text || 'No answer was generated.' });
      }
    } catch (e) {
      if (cancelledRef.current) return;
      setError(formatAIError(e, 'The assistant failed to respond.'));
      // Drop the pending assistant bubble only if nothing streamed into it yet;
      // a partially-streamed answer is kept (its content stays, the error shows below).
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.pending && !last.content) next.pop();
        else if (last?.pending) next[next.length - 1] = { ...last, pending: false };
        return next;
      });
    } finally {
      if (!cancelledRef.current) setBusy(false);
    }
  }, [busy, quotaBlocked, isReadOnly, messages, ai.selectedProvider, ai.currentSource, ai.selectedModel, ai.customApiKey, repoToken, cancelledRef, draftOutcome]);

  const { commitAllowed, commitProposal, dismissProposal } = useProposalActions({
    messages, setMessages, can, isReadOnly, draftOutcome, pendingDraftIndex,
  });

  // Which surface this drawer is: the agent, or help topics (see useAskAvailability).
  const availability = useAskAvailability(askUiMode);

  // `available === false` EXPLICITLY, not `!available`. A payload that does not
  // carry the field (a proxy's generic envelope) would otherwise read as unavailable and replace the assistant with
  // a help page — failing CLOSED, which is the opposite of what the probe
  // promises everywhere else.
  // Rating an answer. Fire-and-forget on purpose: the verdict is recorded
  // locally the moment it is clicked, and a telemetry call that fails is not
  // something to interrupt a reader with.
  // `sources` comes from the CALLER, not from inside the updater: a state
  // updater is not guaranteed to have run by the time the next statement
  // executes (and runs twice under StrictMode), so reading them out of it sent
  // an empty list. The render site already has the message in hand.
  const rate = useCallback((index: number, rating: 'up' | 'down', sources: string[]) => {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, rated: rating } : m)));
    void api.sendAskFeedback({ kind: 'answer', rating, sources }).catch(() => { /* telemetry only */ });
  }, []);

  const blocked = availability?.available === false ? availability : null;
  const helpOnly = askUiMode === 'help-topics' || blocked !== null;

  // NOT gated on the probe finishing. `help-topics` mode is known synchronously
  // (it rides /config, already loaded by the time a drawer can be opened), so
  // that case never flashes. Holding the agent body back for the probe would
  // instead put a round-trip in front of EVERY open to spare a brief composer
  // flash in the one case where the model is scheduled off — and that swap
  // explains itself, because it arrives with the reason.
  if (helpOnly) {
    return (
      <SideDrawer
        title={(
          <span className="inline-flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: 'var(--pb-brand)' }} />
            Ask
          </span>
        )}
        subtitle={blocked?.reason === 'disabled' ? 'AI is turned off for this organization · help topics' : 'Help topics · read-only'}
        ariaLabel="Ask the platform assistant"
        onClose={onClose}
      >
        <div className="flex flex-col h-full min-h-0">
          <AskHelpTopics
            notice={blocked?.message}
            temporary={blocked?.reason === 'scheduled-off'}
            onClose={onClose}
          />
        </div>
      </SideDrawer>
    );
  }

  return (
    <SideDrawer
      title={(
        <span className="inline-flex items-center gap-2">
          <Sparkles className="w-4 h-4" style={{ color: 'var(--pb-brand)' }} />
          Ask
        </span>
      )}
      subtitle="Grounded in the platform docs · read-only"
      ariaLabel="Ask the platform assistant"
      onClose={onClose}
    >
      <div className="flex flex-col h-full min-h-0">
        {/* Screen-reader status. The transcript itself is NOT a live region: it
            streams token by token, and announcing every fragment would talk over
            the user continuously. This announces the state changes that matter —
            when the assistant starts, and the finished answer once it settles. */}
        <p className="sr-only" role="status" aria-live="polite">
          {busy
            ? 'Assistant is responding…'
            : messages.length > 0 && messages[messages.length - 1].role === 'assistant'
              ? `Assistant replied: ${messages[messages.length - 1].content}`
              : ''}
        </p>

        <AskConversation
          scrollRef={scrollRef}
          messages={messages}
          error={error}
          quotaBlocked={quotaBlocked}
          isReadOnly={isReadOnly}
          noProviderHint={!ai.loading && !ai.hasConfiguredProvider && !ai.customApiKey}
          commitAllowed={commitAllowed}
          onSend={send}
          onRate={rate}
          onCommit={commitProposal}
          onDismiss={dismissProposal}
          onClose={onClose}
        />

        <AskModelSettings ai={ai} repoToken={repoToken} onRepoTokenChange={setRepoToken} busy={busy} />

        <AskComposer
          input={input}
          onInputChange={setInput}
          onSend={send}
          onClear={() => { draftOutcome.discarded(); pendingDraftIndex.current = null; setMessages([]); setError(null); clearTranscript(); }}
          hasMessages={messages.length > 0}
          busy={busy}
          quotaBlocked={quotaBlocked}
          isReadOnly={isReadOnly}
          quota={quota}
          keySource={keySource}
          onClose={onClose}
        />
      </div>
    </SideDrawer>
  );
}
