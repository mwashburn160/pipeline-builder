import { CodeBlock } from '@/components/ui/CodeBlock';

interface HelpCodeBlockProps {
  content: string;
  language?: string;
}

/**
 * A code block in help content: the shared {@link CodeBlock} — token surfaces
 * (so its Copy button keeps its contrast in both themes), a language badge, and
 * a keyboard-scrollable body.
 */
export function HelpCodeBlock({ content, language }: HelpCodeBlockProps) {
  return <CodeBlock code={content} language={language} />;
}
