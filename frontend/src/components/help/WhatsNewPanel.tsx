// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { WHATS_NEW } from '@/lib/help/whats-new';

/** Recent-changes feed shown beside the Help page's main column. */
export function WhatsNewPanel() {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-fg inline-flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-warning" />
        What&apos;s new
      </h2>
      <ul className="mt-2 space-y-2 text-xs">
        {WHATS_NEW.map((entry) => (
          <li key={entry.title} className="border-l-2 border-warning-border pl-2">
            <div className="text-2xs uppercase tracking-wider text-warning flex items-center gap-1.5">
              <span>{entry.when}</span>
              <span className="text-fg-subtle font-mono normal-case tracking-normal">· {entry.date}</span>
            </div>
            <div className="text-fg">
              {entry.href
                ? <Link href={entry.href} className="action-link">{entry.title}</Link>
                : entry.title}
            </div>
            {entry.hint && <div className="text-fg-muted">{entry.hint}</div>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
