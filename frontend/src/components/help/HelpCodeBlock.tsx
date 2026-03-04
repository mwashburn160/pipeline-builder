import { CopyButton } from '@/components/ui/CopyButton';

interface HelpCodeBlockProps {
  content: string;
  language?: string;
}

/** Styled code block with language badge and copy button. */
export function HelpCodeBlock({ content, language }: HelpCodeBlockProps) {
  return (
    <div className="relative rounded-lg overflow-hidden bg-gray-900 text-gray-100">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700/50">
        {language ? (
          <span className="text-xs text-gray-400 font-mono">{language}</span>
        ) : (
          <span />
        )}
        <CopyButton text={content} />
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-relaxed">
        <code>{content}</code>
      </pre>
    </div>
  );
}
