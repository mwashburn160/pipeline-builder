// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';

/**
 * One titled block of a moderation review — the heading style the review
 * surfaces share.
 *
 * It was declared identically in `ReviewDiffView` and `SubmissionReviewSection`,
 * which `PublishQueuePanel` renders side by side: two copies of the same six
 * lines, so a change to the heading in one left the other reading differently on
 * the SAME screen.
 */
export function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      {children}
    </section>
  );
}
