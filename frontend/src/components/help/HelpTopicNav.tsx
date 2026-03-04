import type { HelpTopic } from '@/lib/help/types';

interface HelpTopicNavProps {
  topics: HelpTopic[];
  activeTopicId: string;
  onSelectTopic: (id: string) => void;
}

/** Sidebar navigation for help topics. On mobile, renders as a dropdown. */
export function HelpTopicNav({ topics, activeTopicId, onSelectTopic }: HelpTopicNavProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <nav className="hidden lg:block space-y-1">
        {topics.map((topic) => {
          const Icon = topic.icon;
          const active = topic.id === activeTopicId;
          return (
            <button
              key={topic.id}
              onClick={() => onSelectTopic(topic.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                active
                  ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {topic.title}
            </button>
          );
        })}
      </nav>

      {/* Mobile dropdown */}
      <div className="lg:hidden mb-4">
        <select
          value={activeTopicId}
          onChange={(e) => onSelectTopic(e.target.value)}
          className="input w-full text-sm"
          aria-label="Select help topic"
        >
          {topics.map((topic) => (
            <option key={topic.id} value={topic.id}>
              {topic.title}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
