// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { READ_ONLY_REASON } from '@/components/ui/ReadOnlyNotice';
import type { ChatMessage } from './ask-chat';
import type { Proposal } from './proposal';
import { PROPOSAL_META, isDiffProposal, proposalReady, requiredPermissions } from './proposal';
import { ProposalDetails } from './ProposalDetails';
import { ProposalNotes } from './ProposalNotes';

interface ProposalCardProps {
  /** The draft the agent proposed on this message. */
  proposal: Proposal;
  /** Its commit state and error, from the message it rides on. */
  status: ChatMessage['proposalStatus'];
  error: ChatMessage['proposalError'];
  /** Whether this viewer may commit a proposal (every permission its route needs, and not read-only). */
  commitAllowed: (p: Proposal) => boolean;
  isReadOnly: boolean;
  onCommit: () => void;
  onDismiss: () => void;
  /** Close the drawer (following the created entity's link navigates away). */
  onClose: () => void;
}

/**
 * A proposal the Ask agent drafted, as a reviewable card: what it is, the
 * org's policy notes, what the tool left out, the diff or spec, and the
 * Apply / Dismiss actions with the commit state.
 */
export function ProposalCard({ proposal, status, error, commitAllowed, isReadOnly, onCommit, onDismiss, onClose }: ProposalCardProps) {
  const meta = PROPOSAL_META[proposal.kind];
  if (!meta) return null; // ignore an unrecognized proposal kind rather than crash
  const Icon = meta.icon;
  const ready = proposalReady(proposal);
  const diffKind = isDiffProposal(proposal);
  // The write route's own permission — without it the action stays
  // visible (the draft is still worth reading) but inert, saying why.
  const allowed = commitAllowed(proposal);
  const needed = requiredPermissions(proposal).join(' + ');
  // WHY it is inert, not just that it is. In a read-only session
  // the operator may well hold the permission — naming it would
  // send them to look for a grant they already have.
  const blockedReason = isReadOnly ? READ_ONLY_REASON : `Requires the ${needed} permission`;
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
      {status === 'created' ? (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-success">
          <Check className="w-3.5 h-3.5" />{' '}
          <Link href={meta.href} onClick={onClose} className="underline hover:text-brand">{meta.createdText}</Link>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => onCommit()}
            disabled={status === 'creating' || !ready || !allowed}
            title={allowed ? undefined : blockedReason}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-white text-xs disabled:opacity-50"
            style={{ background: 'var(--pb-brand-solid)' }}
          >
            {status === 'creating'
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {meta.busyLabel}</>
              : meta.createLabel}
          </button>
          <button
            type="button"
            onClick={() => onDismiss()}
            disabled={status === 'creating'}
            className="px-3 py-1.5 rounded-lg text-xs text-fg-muted border border-default hover:text-fg disabled:opacity-50"
          >
            Dismiss
          </button>
          <span className="text-2xs text-fg-muted">
            {!allowed ? blockedReason
              : ready ? meta.reviewHint : 'Draft incomplete'}
          </span>
        </div>
      )}
      {status === 'error' && (
        <p role="alert" className="mt-1 text-xs text-danger">{error}</p>
      )}
      {/* Refused, not failed: the live state moved after the draft was
          reviewed, so the approved diff is no longer the diff that
          would be applied — and nothing was written. */}
      {status === 'stale' && (
        <p className="mt-1 flex items-start gap-1 text-xs text-warning-strong" data-testid="ask-stale">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
