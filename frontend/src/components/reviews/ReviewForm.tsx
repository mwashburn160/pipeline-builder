// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { REVIEW_BODY_MAX, REVIEW_TITLE_MAX, reviewErrorMessage } from '@/lib/plugin-reviews';
import type { OwnReview, ReviewBody } from '@/types/plugin-reviews';
import { StarRatingInput } from './StarRating';

/** Tells the author how their markdown will be shown (server-rendered, sanitized). */
export function MarkdownNote() {
  return (
    <>Markdown is supported. Links are marked nofollow and images are not shown.</>
  );
}

/**
 * Write or edit a review. The body is markdown that the SERVER renders and
 * sanitizes; nothing typed here is ever rendered as HTML in the browser.
 */
export function ReviewForm({
  versions, initial, verifiedUse, onSubmit, onCancel,
}: {
  /** Selectable versions (non-yanked), newest first. */
  versions: string[];
  /** The review being edited; null writes a new one. */
  initial: OwnReview | null;
  /** The viewer's org has used the plugin recently (the review gets the badge). */
  verifiedUse: boolean;
  /** Throws to keep the form open with the error shown. */
  onSubmit: (body: ReviewBody) => Promise<void>;
  onCancel?: () => void;
}) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.bodyMd ?? '');
  const [version, setVersion] = useState(initial?.version ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const versionId = useId();
  const editing = !!initial;
  const versionOptions = version && !versions.includes(version) ? [version, ...versions] : versions;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rating < 1) {
      setError('Choose a rating from 1 to 5 stars.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: ReviewBody = editing
        // An edit sends every field so clearing the title or body sticks.
        ? { rating, title: title.trim(), body: body.trim(), ...(version ? { version } : {}) }
        : {
          rating,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(body.trim() ? { body: body.trim() } : {}),
          ...(version ? { version } : {}),
        };
      await onSubmit(payload);
    } catch (err) {
      setError(reviewErrorMessage(err, editing ? 'Could not save your review' : 'Could not post your review'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label={editing ? 'Edit your review' : 'Write a review'} noValidate>
      <StarRatingInput value={rating} onChange={setRating} disabled={busy} />
      <FormField label="Title" id={titleId} hint={`Optional, up to ${REVIEW_TITLE_MAX} characters.`}>
        <Input id={titleId} value={title} maxLength={REVIEW_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      </FormField>
      <FormField label="Review" id={bodyId} hint={`Optional, up to ${REVIEW_BODY_MAX} characters.`}>
        <Textarea id={bodyId} rows={5} value={body} maxLength={REVIEW_BODY_MAX} onChange={(e) => setBody(e.target.value)} disabled={busy} />
      </FormField>
      <p className="text-xs text-fg-subtle"><MarkdownNote /></p>
      {versionOptions.length > 0 && (
        <FormField label="Version you used" id={versionId}>
          <Select id={versionId} value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
            <option value="">Not specified</option>
            {versionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </Select>
        </FormField>
      )}
      {verifiedUse && (
        <p className="text-xs text-fg-muted">Your organization ran this plugin recently, so your review shows a “Verified use” badge. Your organization is never shown.</p>
      )}
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={busy}>{editing ? 'Save review' : 'Post review'}</Button>
        {onCancel && <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>}
      </div>
    </form>
  );
}
