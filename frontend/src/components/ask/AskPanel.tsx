// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Sparkles, Send, BookOpen, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useAIProviders } from '@/hooks/useAIProviders';
import { AiProviderModelPicker } from '@/components/ui/AiProviderModelPicker';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { Disclosure } from '@/components/ui/Disclosure';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import api from '@/lib/api';
import type { AskSource, AskTurn } from '@/lib/api/domains/ask';
import { formatError } from '@/lib/constants';
import { useUnmountedRef } from '../../hooks/useUnmountedRef';
import type { Proposal } from './proposal';
import { PROPOSAL_META, isDiffProposal, proposalDiff, proposalReady, requiredPermissions } from './proposal';
import { ProposalDiffView } from './ProposalDiffView';
import { ProposalNotes } from './ProposalNotes';
import { StaleDraftError, commitProposal as runCommit } from './proposal-commit';

/**
 * The review body of a proposal card.
 *
 * An EDIT proposal is reviewed as a CURRENT -> PROPOSED diff, never as a JSON
 * blob: a blob gets skimmed, and the diff is also literally the commit payload,
 * so a field that is not on screen cannot be applied.
 */
function ProposalDetails({ p }: { p: Proposal }) {
  const json = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

  if (isDiffProposal(p)) return <ProposalDiffView diff={proposalDiff(p)} />;

  if (p.kind === 'plugin') {
    const c = (p.config ?? {}) as Record<string, unknown>;
    const cmds = [...(Array.isArray(c.installCommands) ? c.installCommands : []), ...(Array.isArray(c.commands) ? c.commands : [])];
    const items: DescriptionItem[] = [
      { label: 'Name', value: String(c.name ?? '—') },
      { label: 'Version', value: String(c.version ?? '—') },
      { label: 'Type', value: String(c.pluginType ?? '—') },
      { label: 'Compute', value: String(c.computeType ?? '—') },
      ...(c.primaryOutputDirectory ? [{ label: 'Output dir', value: String(c.primaryOutputDirectory) }] : []),
    ];
    return (
      <div className="space-y-2">
        <DescriptionList items={items} variant="rows" />
        {cmds.length > 0 && <CodeBlock language="commands" code={cmds.join('\n')} className="max-h-52 overflow-y-auto" />}
        {p.dockerfile && <CodeBlock language="Dockerfile" code={p.dockerfile} className="max-h-64 overflow-y-auto" />}
      </div>
    );
  }

  if (p.kind === 'template') {
    const t = (p.template ?? {}) as Record<string, unknown>;
    const inputs = (Array.isArray(t.inputs) ? t.inputs : []) as Array<{ name?: string }>;
    const items: DescriptionItem[] = [
      { label: 'Name', value: String(t.name ?? '—') },
      ...(t.category ? [{ label: 'Category', value: String(t.category) }] : []),
      { label: 'Variables', value: inputs.length ? inputs.map((i) => i.name).filter(Boolean).join(', ') : 'none' },
    ];
    return (
      <div className="space-y-2">
        <DescriptionList items={items} variant="rows" />
        <CodeBlock language="template props (JSON)" code={json(t.props)} className="max-h-64 overflow-y-auto" />
      </div>
    );
  }

  const pr = (p.props ?? {}) as Record<string, unknown>;
  const varNames = pr.vars && typeof pr.vars === 'object' ? Object.keys(pr.vars as object) : [];
  const items: DescriptionItem[] = [
    { label: 'Project', value: String(pr.project ?? '—') },
    { label: 'Organization', value: String(pr.organization ?? '—') },
    ...(pr.pipelineName ? [{ label: 'Name', value: String(pr.pipelineName) }] : []),
    { label: 'Stages', value: String(Array.isArray(pr.stages) ? pr.stages.length : 0) },
    ...(varNames.length ? [{ label: 'Variables', value: varNames.join(', ') }] : []),
  ];
  return (
    <div className="space-y-2">
      <DescriptionList items={items} variant="rows" />
      <CodeBlock language="pipeline props (JSON)" code={json(pr)} className="max-h-64 overflow-y-auto" />
    </div>
  );
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskSource[];
  proposal?: Proposal;
  /** Commit state for a proposal on this message. `stale` is its own state: the
   *  live entity moved after the draft was reviewed, so NOTHING was written —
   *  that must not read as a failed write. */
  proposalStatus?: 'creating' | 'created' | 'error' | 'stale';
  proposalError?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
}

const EXAMPLES = [
  'How do I point my incident tooling at in-cluster Alertmanager?',
  'How do I generate a pipeline from a Git URL?',
  'What environment variables configure billing?',
];

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
  // The stream has always accepted `provider` / `model` / `apiKey`; only the
  // pipeline and plugin AI tabs offered the choice. Same hook, same picker, so
  // the three surfaces stay identical — here the "server" providers are the ask
  // service's own (`GET /ask/providers`), merged with the org's saved keys and
  // the rest of the catalog (selectable with a key of your own).
  const ai = useAIProviders(api.getAskProviders);
  // Forwarded to the agent's repo-analysis tool, never shown to the model, and
  // held only for this panel's lifetime — it is what lets "draft me a pipeline
  // for <private repo>" work at all.
  const [repoToken, setRepoToken] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on unmount (panel close) so the in-flight stream loop stops iterating and
  // stops calling setState on a dead component; stopping iteration also aborts the
  // underlying SSE fetch (streamRequest's AbortController runs in its `finally`).
  const cancelledRef = useUnmountedRef();

  /**
   * Whether this viewer may commit this proposal — EVERY permission its route
   * (or routes: an org-settings change spans services) requires, not just one.
   *
   * `can()` is impersonation-aware, but only for permissions it classifies as
   * mutations — and one of these kinds FILES A REQUEST behind a read permission
   * (any member may request a compliance exemption). Every commit here is a
   * write, so the read-only-session check is applied to all of them rather than
   * left to each permission's own classification.
   */
  const commitAllowed = useCallback(
    (p: Proposal) => !isReadOnly && requiredPermissions(p).every((perm) => can(perm)),
    [can, isReadOnly],
  );

  useEffect(() => {
    // Optional-chain the method: jsdom (and some older browsers) don't implement
    // Element.scrollTo — guard so streaming updates never throw in that environment.
    // `auto` (not `smooth`) avoids janky animation on every streamed token.
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
  }, [messages]);

  const send = useCallback(async (raw: string) => {
    const query = raw.trim();
    if (!query || busy) return;
    setError(null);
    setInput('');

    // History = completed turns so far (exclude the new question).
    const history: AskTurn[] = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, content: m.content }));

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

    try {
      let text = '';
      for await (const ev of api.askAgentStream(query, {
        history,
        // Omitted (not sent empty) when the picker hasn't resolved a choice, so
        // the service keeps its own default.
        ...(ai.selectedProvider ? { provider: ai.selectedProvider } : {}),
        ...(ai.selectedModel ? { model: ai.selectedModel } : {}),
        ...(ai.customApiKey ? { apiKey: ai.customApiKey } : {}),
        ...(repoToken.trim() ? { repoToken: repoToken.trim() } : {}),
      })) {
        if (cancelledRef.current) break; // panel closed — stop iterating (aborts the fetch)
        if (ev.type === 'sources') {
          patchLast({ sources: (ev.data as AskSource[]) ?? [] });
        } else if (ev.type === 'proposal') {
          patchLast({ proposal: ev.data as Proposal });
        } else if (ev.type === 'token') {
          text += String(ev.data ?? '');
          patchLast({ content: text });
        } else if (ev.type === 'error') {
          throw new Error(ev.message || 'The assistant failed to respond.');
        }
      }
      if (!cancelledRef.current) {
        patchLast({ pending: false, content: text || 'No answer was generated.' });
      }
    } catch (e) {
      if (cancelledRef.current) return;
      setError(formatError(e, 'The assistant failed to respond.'));
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
  }, [busy, messages, ai.selectedProvider, ai.selectedModel, ai.customApiKey, repoToken, cancelledRef]);

  /** Commit a proposal via the normal write API (the user's own session). */
  const commitProposal = useCallback(async (index: number) => {
    const p = messages[index]?.proposal;
    if (!p) return;
    // Re-checked here, not only on the button: the write call would 403 anyway,
    // and a refused proposal should never look like a failed draft.
    if (!commitAllowed(p)) return;
    const patch = (u: Partial<ChatMessage>) => setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, ...u } : m)));
    patch({ proposalStatus: 'creating', proposalError: undefined });
    try {
      await runCommit(p);
      patch({ proposalStatus: 'created' });
    } catch (e) {
      // A stale draft is not a failed write — nothing was applied, and saying so
      // is the whole point of the re-read.
      patch({
        proposalStatus: e instanceof StaleDraftError ? 'stale' : 'error',
        proposalError: formatError(e, 'Failed to apply.'),
      });
    }
  }, [messages, commitAllowed]);

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

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          {messages.length === 0 && (
            <div className="text-sm text-fg-muted space-y-3">
              <p>Ask how to use the platform — deployments, pipelines, plugins, billing, and more.</p>
              <div className="space-y-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => send(ex)}
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
                style={m.role === 'user' ? { background: 'var(--pb-brand)' } : undefined}
              >
                <div className="whitespace-pre-wrap break-words">
                  {m.content}
                  {m.pending && <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom animate-pulse bg-current opacity-60" />}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-default space-y-1">
                    <p className="text-2xs uppercase tracking-wide text-fg-muted">Sources</p>
                    {m.sources.map((s) => (
                      <div key={s.id} className="text-xs text-fg-muted">
                        {s.title ?? s.id}
                      </div>
                    ))}
                  </div>
                )}
                {m.proposal && (() => {
                  const meta = PROPOSAL_META[m.proposal.kind];
                  if (!meta) return null; // ignore an unrecognized proposal kind rather than crash
                  const Icon = meta.icon;
                  const proposal = m.proposal;
                  const ready = proposalReady(proposal);
                  const diffKind = isDiffProposal(proposal);
                  // The write route's own permission — without it the action stays
                  // visible (the draft is still worth reading) but inert, saying why.
                  const allowed = commitAllowed(proposal);
                  const needed = requiredPermissions(proposal).join(' + ');
                  return (
                    <div className="mt-2 rounded-xl border border-default p-3 bg-surface">
                      <div className="flex items-center gap-2 text-sm font-medium text-fg">
                        <Icon className="w-4 h-4" style={{ color: 'var(--pb-brand)' }} /> {meta.label}
                        {proposal.target && <span className="font-normal text-fg-muted">{proposal.target}</span>}
                      </div>
                      {proposal.description && (
                        <p className="mt-1 text-xs text-fg-muted">{proposal.description}</p>
                      )}
                      {proposal.error && (
                        <p className="mt-1 text-xs text-warning-strong">{proposal.error}</p>
                      )}
                      {/* The org's own policy verdict, and whether the create route
                          would refuse the draft — above the fold, not behind a summary. */}
                      <ProposalNotes p={proposal} />
                      {/* Fields the TOOL refused before drafting (outside its allowlist).
                          Surfaced rather than swallowed: a draft that asked for something
                          it may not touch is the signal worth seeing. */}
                      {proposal.refusedFields && proposal.refusedFields.length > 0 && (
                        <p className="mt-1 text-2xs text-warning-strong" data-testid="ask-tool-refused">
                          Not proposable, and left out of this draft: {proposal.refusedFields.join(', ')}.
                        </p>
                      )}
                      {/* Drafted but not appliable: a value outside the setting's
                          declared domain, or one whose current value could not be
                          read — so there is no baseline to re-read against. */}
                      {((proposal.invalidFields?.length ?? 0) + (proposal.unreadableFields?.length ?? 0)) > 0 && (
                        <p className="mt-1 text-2xs text-warning-strong" data-testid="ask-tool-dropped">
                          {proposal.invalidFields?.length ? `Out-of-range values, left out: ${proposal.invalidFields.join(', ')}. ` : ''}
                          {proposal.unreadableFields?.length ? `Current value could not be read, so not proposed: ${proposal.unreadableFields.join(', ')}.` : ''}
                        </p>
                      )}
                      {meta.filesRequest && (
                        <p className="mt-1 text-2xs text-fg-muted" data-testid="ask-files-request">
                          This files a request in the organization&apos;s approval queue. An approver decides — nothing changes when you submit it.
                        </p>
                      )}
                      {/* The diff / drafted spec — review before committing (nothing
                          is committed sight-unseen), and for an edit the reviewed
                          diff is exactly what gets sent. */}
                      <details className="mt-2 text-xs" open={diffKind}>
                        <summary className="cursor-pointer select-none text-fg-muted hover:text-brand">
                          {diffKind ? 'Review the change' : 'Review full spec'}
                        </summary>
                        <div className="mt-2">
                          <ProposalDetails p={proposal} />
                        </div>
                      </details>
                      {m.proposalStatus === 'created' ? (
                        <div className="mt-2 inline-flex items-center gap-1 text-xs text-success">
                          <Check className="w-3.5 h-3.5" />{' '}
                          <Link href={meta.href} onClick={onClose} className="underline hover:text-brand">{meta.createdText}</Link>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => commitProposal(i)}
                            disabled={m.proposalStatus === 'creating' || !ready || !allowed}
                            title={allowed ? undefined : `Requires the ${needed} permission`}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-white text-xs disabled:opacity-50"
                            style={{ background: 'var(--pb-brand)' }}
                          >
                            {m.proposalStatus === 'creating'
                              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {meta.busyLabel}</>
                              : meta.createLabel}
                          </button>
                          <span className="text-2xs text-fg-muted">
                            {!allowed ? `Requires the ${needed} permission`
                              : ready ? meta.reviewHint : 'Draft incomplete'}
                          </span>
                        </div>
                      )}
                      {m.proposalStatus === 'error' && (
                        <p className="mt-1 text-xs text-danger">{m.proposalError}</p>
                      )}
                      {/* Refused, not failed: the live state moved after the draft was
                          reviewed, so the approved diff is no longer the diff that
                          would be applied — and nothing was written. */}
                      {m.proposalStatus === 'stale' && (
                        <p className="mt-1 flex items-start gap-1 text-xs text-warning-strong" data-testid="ask-stale">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{m.proposalError}</span>
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}

          {error && (
            <div className="flex items-start gap-2 text-sm text-danger">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Which model answers, and what it may read. Collapsed by default —
            the defaults are the ask service's own and work untouched. */}
        <Disclosure
          title="Model and repository access"
          className="group mt-3 border border-default rounded-xl"
          summaryClassName="cursor-pointer list-none w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-fg-muted hover:text-fg"
          bodyClassName="px-3 pb-3 pt-1 space-y-3 border-t border-default"
        >
          <AiProviderModelPicker ai={ai} disabled={busy} />
          <FormField
            label="Private repository token"
            hint="Sent with this conversation only, so the agent can analyse a private repo you name. It is never shown to the model and is not stored."
          >
            <Input
              type="password"
              autoComplete="off"
              value={repoToken}
              onChange={(e) => setRepoToken(e.target.value)}
              placeholder="Leave empty for public repositories"
              className="text-sm"
              disabled={busy}
            />
          </FormField>
        </Disclosure>

        {/* Composer */}
        <form
          className="mt-3 pt-3 border-t border-default"
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              aria-label="Ask a question"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
              }}
              rows={2}
              placeholder="Ask a question…"
              disabled={busy}
              className="flex-1 resize-none rounded-lg border border-default bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="p-2 rounded-lg text-white disabled:opacity-40"
              style={{ background: 'var(--pb-brand)' }}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-fg-muted">
            <span>Read-only · nothing is changed</span>
            <Link href="/dashboard/help" onClick={onClose} className="inline-flex items-center gap-1 hover:text-brand">
              <BookOpen className="w-3.5 h-3.5" /> Browse all help
            </Link>
          </div>
        </form>
      </div>
    </SideDrawer>
  );
}
