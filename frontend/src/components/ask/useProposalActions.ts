// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Permission } from '@pipeline-builder/api-core/permissions';
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { useAiDraftOutcome } from '@/hooks/useAiDraftOutcome';
import { formatError } from '@/lib/constants';
import type { ChatMessage } from './ask-chat';
import type { Proposal } from './proposal';
import { requiredPermissions } from './proposal';
import { StaleDraftError, commitProposal as runCommit } from './proposal-commit';

interface ProposalActionsArgs {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  can: (perm: Permission) => boolean;
  isReadOnly: boolean;
  draftOutcome: ReturnType<typeof useAiDraftOutcome>;
  /** Index of the message whose proposal is the draft `draftOutcome` tracks. */
  pendingDraftIndex: MutableRefObject<number | null>;
}

/** Apply / Dismiss for the proposals in the Ask transcript, and who may apply them. */
export function useProposalActions({ messages, setMessages, can, isReadOnly, draftOutcome, pendingDraftIndex }: ProposalActionsArgs) {
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
      if (pendingDraftIndex.current === index) {
        pendingDraftIndex.current = null;
        draftOutcome.accepted();
      }
    } catch (e) {
      // A stale draft is not a failed write — nothing was applied, and saying so
      // is the whole point of the re-read.
      patch({
        proposalStatus: e instanceof StaleDraftError ? 'stale' : 'error',
        proposalError: formatError(e, 'Failed to apply.'),
      });
    }
  }, [messages, setMessages, commitAllowed, draftOutcome, pendingDraftIndex]);

  /** Dismiss a proposal: its card goes, and a pending draft is reported discarded. */
  const dismissProposal = useCallback((index: number) => {
    setMessages((prev) => prev.map((m, i) => (i === index ? { ...m, proposal: undefined, proposalStatus: undefined, proposalError: undefined } : m)));
    if (pendingDraftIndex.current === index) {
      pendingDraftIndex.current = null;
      draftOutcome.discarded();
    }
  }, [setMessages, draftOutcome, pendingDraftIndex]);

  return { commitAllowed, commitProposal, dismissProposal };
}
