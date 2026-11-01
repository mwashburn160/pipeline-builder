// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { SupportCaseNote } from '@/types';

/** Matches the server's bound; a working note, not a field. */
const NOTE_MAX = 5000;

interface SupportCaseNotesProps {
  threadId: string;
  caseNumber: number;
}

/**
 * Staff-only notes on a case — triage context that the customer must not see.
 *
 * THE ONE SURFACE ON A CASE THAT IS NOT SHARED. Notes live in their own table
 * rather than as a flag on `messages`, and that is a safety property rather
 * than a schema preference: `messages` is read through one shared visibility
 * predicate, so a flag there would leak a note from any read path that forgot
 * the extra condition. A separate table has to be joined deliberately, so it
 * cannot leak by omission. All three routes behind this are system-admin gated
 * server-side as well.
 *
 * Rendered only on the staff queue page, which is itself `systemAdminOnly` in
 * `nav.ts`. Collapsed by default: notes are reference material during triage,
 * not something to read on every row of a queue.
 *
 * Loaded on EXPAND rather than with the queue, because a queue of fifty cases
 * would otherwise make fifty note requests to show nothing.
 */
export function SupportCaseNotes({ threadId, caseNumber }: SupportCaseNotesProps) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<SupportCaseNote[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.getSupportCaseNotes(threadId);
      setNotes(res.data?.notes ?? []);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && notes === null) await load();
  };

  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.addSupportCaseNote(threadId, content);
      if (!res.success) {
        setError(res.message ?? 'The note was not saved');
      } else {
        setDraft('');
        await load();
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (noteId: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.deleteSupportCaseNote(threadId, noteId);
      if (!res.success) setError(res.message ?? 'The note was not removed');
      else await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 w-full">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"
        aria-expanded={open}
        aria-label={`Internal notes for case ${caseNumber}`}
      >
        <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />
        Internal notes
        {notes !== null && <span>({notes.length})</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
          {/* Said plainly and every time. A staff member deciding what to write
              needs to know who can read it, and "internal" is doing a lot of
              work in a product where almost everything else on a case is
              shared with the customer. */}
          <p className="text-xs text-fg-muted">Visible to the support team only — never to the customer.</p>

          {error && <ErrorAlert message={error} />}

          {notes?.length === 0 && <p className="text-xs text-fg-muted">No notes yet.</p>}

          {notes?.map((n) => (
            <div key={n.id} className="flex items-start gap-2 text-xs">
              <div className="flex-1 min-w-0">
                <p className="whitespace-pre-wrap break-words">{n.content}</p>
                <p className="text-fg-muted">
                  {n.createdBy} · {new Date(n.createdAt).toLocaleString()}
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => remove(n.id)}
                aria-label="Delete note"
              >
                <Trash2 className="w-3 h-3" aria-hidden="true" />
              </Button>
            </div>
          ))}

          <div className="space-y-1">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, NOTE_MAX))}
              placeholder="What the next person on this case needs to know…"
              rows={2}
              className="text-xs"
              aria-label={`New internal note for case ${caseNumber}`}
            />
            <Button size="sm" disabled={busy || !draft.trim()} onClick={add}>Add note</Button>
          </div>
        </div>
      )}
    </div>
  );
}
