import { motion } from 'framer-motion';
import type { HelpTopic } from '@/lib/help/types';
import { HelpSectionCard } from './HelpSection';
import { PluginCatalog } from './PluginCatalog';

interface HelpContentProps {
  topic: HelpTopic;
}

/** Renders the active help topic's title, description, and sections. */
export function HelpContent({ topic }: HelpContentProps) {
  const Icon = topic.icon;

  return (
    <motion.div
      key={topic.id}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Topic header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-900/20">
            <Icon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {topic.title}
          </h2>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">{topic.description}</p>
      </div>

      {/* Sections */}
      {topic.sections.map((section) => (
        <div key={section.id} className="card mb-4">
          <HelpSectionCard title={section.title} blocks={section.blocks} />
          {/* Render plugin catalog inline for the plugins topic */}
          {topic.id === 'plugins' && section.id === 'plugin-catalog' && (
            <PluginCatalog />
          )}
        </div>
      ))}
    </motion.div>
  );
}
