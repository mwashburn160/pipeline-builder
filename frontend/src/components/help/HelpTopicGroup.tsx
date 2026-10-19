// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { HelpTopic } from '@/lib/help/types';
import { Card } from '@/components/ui/Card';
import { HelpAccordionTopic } from './HelpAccordionTopic';

interface HelpTopicGroupProps {
  category: string;
  topics: HelpTopic[];
  /** Expand the group's first topic on mount. */
  openFirst?: boolean;
  /** Topic id the URL hash asked for — expanded wherever it lives. */
  openId?: string;
}

/**
 * One category of the Help browse view: a heading plus its topics as divided
 * rows inside a SINGLE Card: a padded Card per topic would make a collapsed
 * category mostly whitespace; one Card with dividers keeps the list scannable.
 */
export function HelpTopicGroup({ category, topics, openFirst = false, openId }: HelpTopicGroupProps) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
        {category}
        <span className="ml-2 font-normal normal-case tracking-normal text-fg-subtle">
          {topics.length} {topics.length === 1 ? 'topic' : 'topics'}
        </span>
      </h2>
      <Card className="p-0 overflow-hidden divide-y divide-default">
        {topics.map((topic, i) => (
          <div key={topic.id} id={`topic-${topic.id}`} className="scroll-mt-24">
            <HelpAccordionTopic
              topic={topic}
              // A deep-linked topic wins over the "expand the first one" default,
              // which would otherwise leave two open and scroll to the wrong one.
              defaultOpen={openId ? openId === topic.id : openFirst && i === 0}
              bare
            />
          </div>
        ))}
      </Card>
    </section>
  );
}
