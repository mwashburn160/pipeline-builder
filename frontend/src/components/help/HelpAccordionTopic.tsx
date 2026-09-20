import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { HelpTopic } from '@/lib/help/types';
import { Card } from '@/components/ui/Card';
import { HelpSectionCard } from './HelpSection';
import { PluginCatalog } from './PluginCatalog';

interface HelpAccordionTopicProps {
  topic: HelpTopic;
  defaultOpen?: boolean;
  /**
   * Render without the surrounding Card. Used where a parent Card already
   * provides the surface — the search-result card, and HelpTopicGroup, which
   * lists a whole category as divided rows in one Card. Nesting Cards
   * double-draws the border, shadow AND padding.
   */
  bare?: boolean;
}

/** A single help topic rendered as a collapsible accordion. */
export function HelpAccordionTopic({ topic, defaultOpen = false, bare = false }: HelpAccordionTopicProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const Icon = topic.icon;

  const body = (
    <>
      {/* Clickable header */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
      >
        <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex-shrink-0">
          <Icon className="w-4 h-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-fg">
            {topic.title}
          </h3>
          <p className="text-xs text-fg-muted truncate">
            {topic.description}
          </p>
        </div>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown className="w-5 h-5 text-fg-subtle" />
        </motion.div>
      </button>

      {/* Expandable body */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 border-t border-gray-200 dark:border-gray-700">
              {/* Generated topics can repeat a section id (e.g. two `overview`
                  sections), so the index disambiguates the key. */}
              {topic.sections.map((section, i) => (
                <div key={`${section.id}:${i}`}>
                  <HelpSectionCard title={section.title} blocks={section.blocks} />
                  {topic.id === 'plugins' && section.id === 'plugin-catalog' && (
                    <PluginCatalog />
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  // `.card` carries p-6; the header row pads itself, so the Card must not.
  return bare ? body : <Card className="p-0 overflow-hidden">{body}</Card>;
}
