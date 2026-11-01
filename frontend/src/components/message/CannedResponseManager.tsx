// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { StickyNote, Trash2 } from 'lucide-react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/Loading';
import { RetryError } from '@/components/ui/RetryError';
import { useFetch } from '@/hooks/useFetch';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';
import type { CannedResponse } from '@/types';

/** Matches the server's bounds. */
const TITLE_MAX = 200;
const BODY_MAX = 5000;

/**
 * Author and retire the canned-reply library.
 *
 * WITHOUT THIS THE FEATURE IS UNREACHABLE, which is how it shipped: the routes,
 * the store functions and the insert picker all existed, but nothing could
 * CREATE a template — so the library stayed permanently empty, and the picker
 * renders nothing on an empty list, making the whole thing invisible rather
 * than visibly broken. The tell was three api-client methods
 * (`createCannedResponse` / `updateCannedResponse` / `deleteCannedResponse`)
 * with no caller anywhere in the UI.
 *
 * Lives on the staff queue page, which is `systemAdminOnly` in `nav.ts`. The
 * templates are system-wide rather than per-tenant — the vendor's own wording
 * for recurring questions — so there is no org context to scope this to, and
 * all four routes are system-admin gated on read as well as write.
 *
 * Editing is in place: a template's whole value is that its wording gets
 * improved as the desk learns what answers well, so the edit has to be as cheap
 * as the create.
 */
export function CannedResponseManager() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const templates = useFetch(async () => {
    const res = await api.getCannedResponses();
    return res.data?.responses ?? [];
  }, []);

  const list: CannedResponse[] = templates.data ?? [];

  const run = async (label: string, fn: () => Promise<{ success: boolean; message?: string }>) => {
    setBusy(label);
    setError('');
    try {
      const res = await fn();
      if (!res.success) {
        setError(res.message ?? 'That change was not saved');
      } else {
        setTitle('');
        setBody('');
        setEditing(null);
        await templates.refetch();
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) return;
    return editing
      ? run('save', () => api.updateCannedResponse(editing, { title: t, body: b }))
      : run('save', () => api.createCannedResponse(t, b));
  };

  const edit = (tpl: CannedResponse) => {
    setEditing(tpl.id);
    setTitle(tpl.title);
    setBody(tpl.body);
    setError('');
  };

  return (
    <SectionCard title="Canned replies" icon={StickyNote}>
      <div className="space-y-3">
        <p className="text-xs text-fg-muted">
          Shared across every customer — the desk&apos;s own wording for recurring questions. Picking one in a
          reply inserts it; it never sends on its own.
        </p>

        {templates.loading && <LoadingSpinner />}
        {templates.error && <RetryError message="The canned replies could not be loaded" onRetry={templates.refetch} />}
        {error && <ErrorAlert message={error} />}

        {!templates.loading && !templates.error && list.length === 0 && (
          <EmptyState
            title="No canned replies yet"
            description="Add one below. Until then the picker in a reply box stays hidden, because an empty picker is worse than none."
          />
        )}

        {list.length > 0 && (
          <ul className="divide-y divide-border">
            {list.map((t) => (
              <li key={t.id} className="flex items-start gap-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{t.title}</p>
                  {/* Truncated: the list is for choosing, and the full text is
                      one click away in the editor. */}
                  <p className="text-xs text-fg-muted truncate">{t.body}</p>
                </div>
                <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => edit(t)}>
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => run(t.id, () => api.deleteCannedResponse(t.id))}
                  aria-label={`Retire ${t.title}`}
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
            placeholder="What this answers, e.g. “Rotating a service key”"
            aria-label="Canned reply title"
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
            placeholder="The reply itself. Staff can edit it after inserting."
            rows={3}
            aria-label="Canned reply body"
          />
          <div className="flex items-center gap-2">
            <Button disabled={busy !== null || !title.trim() || !body.trim()} onClick={save}>
              {editing ? 'Save changes' : 'Add canned reply'}
            </Button>
            {editing && (
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => { setEditing(null); setTitle(''); setBody(''); }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
