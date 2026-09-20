// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Sparkles, Send, BookOpen, AlertTriangle, GitBranch, Package, LayoutTemplate, Check, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SideDrawer } from '@/components/ui/SideDrawer';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { DescriptionList, type DescriptionItem } from '@/components/ui/DescriptionList';
import api from '@/lib/api';
import { invalidate } from '@/lib/api-cache';
import type { AskSource, AskTurn } from '@/lib/api/domains/ask';
import type { BuilderProps } from '@/types';
import { formatError } from '@/lib/constants';

/** A reviewable draft the agent produced (nothing is created until the user commits). */
interface Proposal {
  kind: 'pipeline' | 'plugin' | 'template';
  description?: string;
  props?: Record<string, unknown>; // pipeline
  config?: Record<string, unknown>; // plugin
  dockerfile?: string; // plugin
  template?: Record<string, unknown>; // template
}

/** Per-kind card presentation + the dashboard the created resource lives on. */
const PROPOSAL_META: Record<Proposal['kind'], { label: string; icon: LucideIcon; createLabel: string; href: string; createdText: string }> = {
  pipeline: { label: 'Proposed pipeline', icon: GitBranch, createLabel: 'Create pipeline', href: '/dashboard/pipelines', createdText: 'Created — open pipelines' },
  plugin: { label: 'Proposed plugin', icon: Package, createLabel: 'Create plugin', href: '/dashboard/plugins', createdText: 'Build queued — open plugins' },
  template: { label: 'Proposed template', icon: LayoutTemplate, createLabel: 'Create template', href: '/dashboard/templates', createdText: 'Created — open templates' },
};

/** Whether a draft carries the fields its create API requires (gates the button). */
function proposalReady(p: Proposal): boolean {
  if (p.kind === 'pipeline') return !!(p.props?.project && p.props?.organization);
  if (p.kind === 'plugin') return !!(p.config && p.dockerfile);
  return !!(p.template as { name?: string } | undefined)?.name;
}

/** A key/value + code review of a drafted spec, per kind. */
function ProposalDetails({ p }: { p: Proposal }) {
  const json = (v: unknown) => JSON.stringify(v ?? {}, null, 2);

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
  /** Commit state for a proposal on this message. */
  proposalStatus?: 'creating' | 'created' | 'error';
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Set on unmount (panel close) so the in-flight stream loop stops iterating and
  // stops calling setState on a dead component; stopping iteration also aborts the
  // underlying SSE fetch (streamRequest's AbortController runs in its `finally`).
  const cancelledRef = useRef(false);
  useEffect(() => () => { cancelledRef.current = true; }, []);

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
      for await (const ev of api.askAgentStream(query, { history })) {
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
  }, [busy, messages]);

  /** Commit a proposal via the normal create API (the user's own session). */
  const commitProposal = useCallback(async (index: number) => {
    const p = messages[index]?.proposal;
    if (!p) return;
    const patch = (u: Partial<ChatMessage>) => setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, ...u } : m)));
    patch({ proposalStatus: 'creating', proposalError: undefined });
    try {
      if (p.kind === 'pipeline') {
        // The drafted `props` is a full BuilderProps (carries project/organization);
        // wrap it in the create envelope exactly like the normal create flow.
        const bp = p.props as BuilderProps | undefined;
        if (!bp?.project || !bp.organization) throw new Error('Draft is incomplete (missing project/organization).');
        await api.createPipeline({
          project: bp.project,
          organization: bp.organization,
          pipelineName: bp.pipelineName,
          description: p.description,
          props: bp,
          visibility: 'private',
        });
        // Every cached pipeline list (the Pipelines page, palette, home) is stale now.
        invalidate.pipelines();
      } else if (p.kind === 'plugin') {
        if (!p.config || !p.dockerfile) throw new Error('Draft is incomplete (missing config or Dockerfile).');
        await api.deployGeneratedPlugin({
          ...(p.config as Parameters<typeof api.deployGeneratedPlugin>[0]),
          dockerfile: p.dockerfile,
          visibility: 'private',
        });
      } else {
        const tmpl = p.template as Parameters<typeof api.createPipelineTemplate>[0] | undefined;
        if (!tmpl?.name || !tmpl.props) throw new Error('Draft is incomplete (missing name/props).');
        await api.createPipelineTemplate(tmpl);
      }
      patch({ proposalStatus: 'created' });
    } catch (e) {
      patch({ proposalStatus: 'error', proposalError: formatError(e, 'Failed to create.') });
    }
  }, [messages]);

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
                    : 'max-w-[95%] rounded-2xl px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100'
                }
                style={m.role === 'user' ? { background: 'var(--pb-brand)' } : undefined}
              >
                <div className="whitespace-pre-wrap break-words">
                  {m.content}
                  {m.pending && <span className="inline-block w-2 h-4 ml-0.5 align-text-bottom animate-pulse bg-current opacity-60" />}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1">
                    <p className="text-2xs uppercase tracking-wide text-fg-muted">Sources</p>
                    {m.sources.map((s) => (
                      <div key={s.id} className="text-xs text-gray-600 dark:text-gray-300">
                        {s.title ?? s.id}
                      </div>
                    ))}
                  </div>
                )}
                {m.proposal && (() => {
                  const meta = PROPOSAL_META[m.proposal.kind];
                  if (!meta) return null; // ignore an unrecognized proposal kind rather than crash
                  const Icon = meta.icon;
                  const ready = proposalReady(m.proposal);
                  return (
                    <div className="mt-2 rounded-xl border border-default p-3 bg-surface">
                      <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
                        <Icon className="w-4 h-4" style={{ color: 'var(--pb-brand)' }} /> {meta.label}
                      </div>
                      {m.proposal.description && (
                        <p className="mt-1 text-xs text-fg-muted">{m.proposal.description}</p>
                      )}
                      {/* Full drafted spec — review before creating (nothing is committed sight-unseen). */}
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer select-none text-fg-muted hover:text-brand">
                          Review full spec
                        </summary>
                        <div className="mt-2">
                          <ProposalDetails p={m.proposal} />
                        </div>
                      </details>
                      {m.proposalStatus === 'created' ? (
                        <div className="mt-2 inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                          <Check className="w-3.5 h-3.5" />{' '}
                          <Link href={meta.href} onClick={onClose} className="underline hover:text-brand">{meta.createdText}</Link>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => commitProposal(i)}
                            disabled={m.proposalStatus === 'creating' || !ready}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-white text-xs disabled:opacity-50"
                            style={{ background: 'var(--pb-brand)' }}
                          >
                            {m.proposalStatus === 'creating'
                              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating…</>
                              : meta.createLabel}
                          </button>
                          <span className="text-2xs text-fg-muted">
                            {ready ? 'Review before creating' : 'Draft incomplete'}
                          </span>
                        </div>
                      )}
                      {m.proposalStatus === 'error' && (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{m.proposalError}</p>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          className="mt-3 pt-3 border-t border-default"
          onSubmit={(e) => { e.preventDefault(); send(input); }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              aria-label="Ask a question"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
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
