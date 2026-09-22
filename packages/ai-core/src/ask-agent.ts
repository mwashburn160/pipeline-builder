// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// The "Ask" agent's read-only "Explain" brain: retrieval-augmented how-to answers.
//
// `answerHowTo` / `streamHowTo` retrieve the most relevant documentation chunks from
// a GroundingIndex and ask the model to answer using ONLY that context, citing the
// sections it used. This is the Phase 1 (read-only) core — no write tools, nothing
// mutated. The HTTP service wires a model (via the provider registry) + a docs index
// to these functions and streams the result over SSE.

import { generateText, streamText } from 'ai';
import type { LanguageModel } from 'ai';

import type { GroundingIndex, GroundingHit } from './grounding.js';

/** A source the answer was grounded in, for attribution / deep-linking. */
export interface AskSource {
  id: string;
  title?: string;
  url?: string;
}

export interface AnswerHowToOptions {
  model: LanguageModel;
  /** The user's question. */
  query: string;
  /** Documentation index to ground against. */
  index: GroundingIndex;
  /** How many chunks to retrieve (default 5). */
  topK?: number;
  /** Optional prior turns for multi-turn context (client-held in v1). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Aborts the provider call when the client disconnects (avoids wasted spend). */
  abortSignal?: AbortSignal;
  /** Caps the answer's length (and so its token cost). Unset ⇒ the provider default. */
  maxOutputTokens?: number;
}

const SYSTEM_PROMPT = [
  'You are the Pipeline Builder "Ask" assistant. You help users understand and use the',
  'platform. Answer the question using ONLY the documentation context provided below.',
  '',
  'Rules:',
  '- If the answer is not in the context, say you do not have documentation covering it and',
  '  suggest the closest relevant area — do NOT invent commands, env vars, or endpoints.',
  '- Be concise and concrete. Prefer steps and exact names from the context.',
  '- When you use a section, cite it by its title so the user can find it.',
  '- This is a read-only assistant: never claim to have changed anything.',
].join('\n');

/** Assemble the retrieved chunks into a labelled context block for the model. */
export function buildGroundingContext(hits: GroundingHit[]): string {
  if (hits.length === 0) return '(no matching documentation found)';
  return hits
    .map((h, i) => {
      const label = h.doc.title ? `${h.doc.title} [${h.doc.id}]` : h.doc.id;
      return `### Source ${i + 1}: ${label}\n${h.doc.text}`;
    })
    .join('\n\n');
}

function toSources(hits: GroundingHit[]): AskSource[] {
  return hits.map((h) => ({ id: h.doc.id, title: h.doc.title, url: h.doc.url }));
}

/** Retrieve, build the grounded messages, and derive the sources — shared prelude. */
function prepare(opts: AnswerHowToOptions): { messages: ReturnType<typeof buildMessages>; sources: AskSource[] } {
  const hits = opts.index.search(opts.query, opts.topK ?? 5);
  const context = buildGroundingContext(hits);
  return { messages: buildMessages(opts, context), sources: toSources(hits) };
}

/** Build the messages array (system grounding + optional history + question). */
function buildMessages(opts: AnswerHowToOptions, context: string) {
  return [
    { role: 'system' as const, content: `${SYSTEM_PROMPT}\n\n## Documentation context\n\n${context}` },
    ...(opts.history ?? []),
    { role: 'user' as const, content: opts.query },
  ];
}

/**
 * Answer a how-to question, grounded in the docs index. Returns the full text plus
 * the sources it was grounded in.
 */
export async function answerHowTo(opts: AnswerHowToOptions): Promise<{ text: string; sources: AskSource[] }> {
  const { messages, sources } = prepare(opts);
  const result = await generateText({ model: opts.model, messages, abortSignal: opts.abortSignal, maxOutputTokens: opts.maxOutputTokens });
  return { text: result.text, sources };
}

/**
 * Streaming variant — returns the retrieved `sources` immediately (so the UI can show
 * them while tokens arrive) and the live `textStream`.
 */
/** What a how-to stream yields. */
export type AskStreamEvent =
  /** The provider has started responding — a paid call has been made. */
  | { type: 'provider-responded' }
  /** A chunk of answer text. */
  | { type: 'text'; text: string };

/**
 * Stream a grounded answer.
 *
 * Built on the SDK's full stream rather than `textStream`, which silently drops
 * error parts (a failed provider call would look like an empty "answer") and
 * gives no signal that the provider was reached. Here a provider error THROWS
 * from the iterator, and `provider-responded` marks the moment a call was paid
 * for — so callers can refund exactly when the provider was never reached.
 */
export function streamHowTo(opts: AnswerHowToOptions): { sources: AskSource[]; events: AsyncIterable<AskStreamEvent> } {
  const { messages, sources } = prepare(opts);
  const result = streamText({ model: opts.model, messages, abortSignal: opts.abortSignal, maxOutputTokens: opts.maxOutputTokens });
  return { sources, events: toAskEvents(result.fullStream) };
}

async function* toAskEvents(parts: AsyncIterable<{ type: string; delta?: string; error?: unknown }>): AsyncIterable<AskStreamEvent> {
  for await (const part of parts) {
    switch (part.type) {
      case 'start-step':
        yield { type: 'provider-responded' };
        break;
      case 'text-delta':
        if (part.delta) yield { type: 'text', text: part.delta };
        break;
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      default:
        break;
    }
  }
}
