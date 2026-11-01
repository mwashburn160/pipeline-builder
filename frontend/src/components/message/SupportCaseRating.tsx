// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import api from '@/lib/api';
import { formatError } from '@/lib/constants';

interface SupportCaseRatingProps {
  threadId: string;
  caseNumber: number;
  /** The score already given, or null when unrated. */
  current: number | null;
  onRated?: () => void;
}

/**
 * The customer's verdict on a finished case, 1–5.
 *
 * THE ONLY CASE CONTROL STAFF CANNOT TOUCH, and that asymmetry is the point: a
 * vendor-settable satisfaction score is not a satisfaction score. The server
 * passes `staff: false` unconditionally on this route, so there is no desk-side
 * variant of it.
 *
 * It measures the thing that first-response latency cannot. The product being
 * sold is a response TIME, and hitting every target says only that we answered
 * fast — not that the answer helped. Without this nothing in the system would
 * notice a desk that is punctual and useless.
 *
 * ALWAYS RE-RATEABLE, never locked after the first click. Somebody who rates in
 * frustration and comes back a day later should be able to change it; freezing
 * the first number would make the metric measure how people felt at their worst
 * moment rather than what they ended up thinking.
 */
export function SupportCaseRating({ threadId, caseNumber, current, onRated }: SupportCaseRatingProps) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const rate = async (score: number) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.rateSupportCase(threadId, score, comment.trim() || undefined);
      if (!res.success) {
        setError(res.message ?? 'That rating was not saved');
      } else {
        setComment('');
        setOpen(false);
        onRated?.();
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-fg-muted">
        {current === null ? 'How did we do?' : 'Your rating:'}
      </span>

      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            disabled={busy}
            onClick={() => rate(n)}
            aria-label={`Rate case ${caseNumber} ${n} out of 5`}
            // `aria-pressed` rather than a disabled state: the current score is
            // shown as selected and is still clickable, because re-rating is
            // deliberately allowed.
            aria-pressed={current === n}
            className="p-0.5 disabled:opacity-50"
          >
            <Star
              className={`w-4 h-4 ${current !== null && n <= current ? 'text-warning' : 'text-fg-muted'}`}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>

      {!open ? (
        <button type="button" className="text-info underline" onClick={() => setOpen(true)}>
          Add a comment
        </button>
      ) : (
        <>
          <Input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Anything we should know?"
            aria-label={`Comment on case ${caseNumber}`}
            className="text-xs flex-1 min-w-0"
          />
          {/* The comment rides along with the NEXT star click rather than
              having its own submit: a comment with no score is not a rating,
              and two buttons would invite exactly that. */}
          <span className="text-fg-muted">pick a rating to send it</span>
        </>
      )}

      {error && <ErrorAlert message={error} />}
    </div>
  );
}
