import { Info, AlertTriangle } from 'lucide-react';
import type { ContentBlock } from '@/lib/help/types';
import { HelpCodeBlock } from './HelpCodeBlock';
import { HelpTable } from './HelpTable';

interface HelpSectionProps {
  title: string;
  blocks: ContentBlock[];
}

/** Renders a single titled section with its content blocks. */
export function HelpSectionCard({ title, blocks }: HelpSectionProps) {
  return (
    <div className="mb-6">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-3">
        {title}
      </h3>
      <div className="space-y-4">
        {blocks.map((block, i) => (
          // Content blocks have no stable id in the help data; pairing the
          // discriminant `type` with the index is at least more meaningful
          // than the bare index and survives reordering within a type.
          <ContentBlockRenderer key={`${block.type}-${i}`} block={block} />
        ))}
      </div>
    </div>
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          {block.content}
        </p>
      );

    case 'code':
      return <HelpCodeBlock content={block.content} language={block.language} />;

    case 'table':
      return <HelpTable headers={block.headers} rows={block.rows} />;

    case 'list':
      return (
        <ul className="space-y-1.5 text-sm text-gray-600 dark:text-gray-400">
          {block.items.map((item, i) => (
            // Help list items are plain strings; the string itself is a
            // stable identifier within the list. Fall back to the index
            // only on the (extremely rare) duplicate-string case.
            <li key={`${item}-${i}`} className="flex gap-2">
              <span className="text-gray-400 dark:text-gray-500 mt-0.5 flex-shrink-0">&#8226;</span>
              <span className="leading-relaxed">{item}</span>
            </li>
          ))}
        </ul>
      );

    case 'note':
      return (
        <div className="flex gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300 leading-relaxed">{block.content}</p>
        </div>
      );

    case 'warning':
      return (
        <div className="flex gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-700 dark:text-amber-300 leading-relaxed">{block.content}</p>
        </div>
      );
  }
}
