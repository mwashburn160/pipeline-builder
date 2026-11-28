// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AskSource } from '@/lib/api/domains/ask';
import type { AIServedByInfo, AIUsageInfo } from '@/components/ui/AIServedBy';
import type { Proposal } from './proposal';

/** One bubble of the Ask transcript (a question, or an answer and what came with it). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: AskSource[];
  /** The reader's verdict, once given. Persisted with the transcript so it
   *  survives a drawer close and does not invite a second vote. */
  rated?: 'up' | 'down';
  proposal?: Proposal;
  /** Commit state for a proposal on this message. `stale` is its own state: the
   *  live entity moved after the draft was reviewed, so NOTHING was written —
   *  that must not read as a failed write. */
  proposalStatus?: 'creating' | 'created' | 'error' | 'stale';
  proposalError?: string;
  /** True while the assistant message is still streaming. */
  pending?: boolean;
  /** Who answered (after org-key selection and any failover) and what it cost — from the `done` event. */
  servedBy?: AIServedByInfo;
  usage?: AIUsageInfo;
  /** Tokens the turn's in-process tool generations spent (added to the footer's total). */
  toolUsage?: AIUsageInfo;
  /** `aiCalls` quota units the turn drew (0 when waived). */
  slotsCharged?: number;
}

/**
 * The part of a transcript worth carrying across a drawer close.
 *
 * Deliberately NOT the whole message. Two things are dropped:
 *
 *   * `proposal` and its commit state. A draft is live session state — restoring
 *     one would show a "created" badge earned in a previous sitting, and the
 *     commit path re-reads the entity first anyway, so a restored card buys
 *     nothing. More importantly a proposal holds RAW field values: redaction is
 *     applied where it renders (`redactionFor`/`describeValue`), and the comment
 *     on that allowlist says it "admits no secret today … defence in depth".
 *     Persisting the raw object would quietly make that assumption load-bearing
 *     for STORAGE, so a later allowlist change could put a credential in
 *     sessionStorage with nothing nearby to say so.
 *   * `pending`, so a half-streamed bubble cannot come back as a stuck one.
 *
 * What remains is what a reader actually wants back: the questions, the answers,
 * their citations, and any verdict already given.
 */
export function persistable(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.pending && m.content)
    .map(({ role, content, sources, rated }) => ({ role, content, sources, rated }));
}

/** Example questions offered on an empty transcript. */
export const EXAMPLES = [
  'How do I point my incident tooling at in-cluster Alertmanager?',
  'How do I generate a pipeline from a Git URL?',
  'What environment variables configure billing?',
];
