import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { HelpTopic } from '@/lib/help/types';
import { HelpSectionCard } from './HelpSection';
import { PluginCatalog } from './PluginCatalog';

interface HelpAccordionTopicProps {
  topic: HelpTopic;
  defaultOpen?: boolean;
}

/** A single help topic rendered as a collapsible accordion. */
export function HelpAccordionTopic({ topic, defaultOpen = false }: HelpAccordionTopicProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const Icon = topic.icon;

  return (
    <div className="card overflow-hidden">
      {/* Clickable header */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
      >
        <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 flex-shrink-0">
          <Icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {topic.title}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
            {topic.description}
          </p>
        </div>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0"
        >
          <ChevronDown className="w-5 h-5 text-gray-400" />
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
            <div className="px-5 pb-5 pt-2 border-t border-gray-200 dark:border-gray-700">
              {topic.sections.map((section) => (
                <div key={section.id}>
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
    </div>
  );
}
