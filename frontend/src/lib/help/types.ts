import type { LucideIcon } from 'lucide-react';

/** A block of content within a help section. */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; items: string[] }
  | { type: 'note'; content: string }
  | { type: 'warning'; content: string };

/** A titled section within a help topic. */
export interface HelpSection {
  id: string;
  title: string;
  blocks: ContentBlock[];
}

/** A complete help topic with icon, description, and sections. */
export interface HelpTopic {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  sections: HelpSection[];
}
