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
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 inline-flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-amber-500" />
        What&apos;s new
      </h2>
      <ul className="mt-2 space-y-2 text-xs">
        {WHATS_NEW.map((entry) => (
          <li key={entry.title} className="border-l-2 border-amber-300 dark:border-amber-700 pl-2">
            <div className="text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <span>{entry.when}</span>
              <span className="text-gray-400 dark:text-gray-500 font-mono normal-case tracking-normal">· {entry.date}</span>
            </div>
            <div className="text-gray-800 dark:text-gray-200">
              {entry.href
                ? <Link href={entry.href} className="action-link">{entry.title}</Link>
                : entry.title}
            </div>
            {entry.hint && <div className="text-gray-500 dark:text-gray-400">{entry.hint}</div>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
