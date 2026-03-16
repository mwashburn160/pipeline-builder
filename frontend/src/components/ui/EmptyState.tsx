import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  illustration?: 'default' | 'pipelines' | 'plugins' | 'messages' | 'search';
}

const illustrationColors: Record<string, { bg: string; icon: string; ring: string }> = {
  default: {
    bg: 'bg-gray-100 dark:bg-gray-800',
    icon: 'text-gray-400 dark:text-gray-500',
    ring: '',
  },
  pipelines: {
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    icon: 'text-blue-400 dark:text-blue-500',
    ring: 'ring-4 ring-blue-100/50 dark:ring-blue-900/30',
  },
  plugins: {
    bg: 'bg-purple-50 dark:bg-purple-900/20',
    icon: 'text-purple-400 dark:text-purple-500',
    ring: 'ring-4 ring-purple-100/50 dark:ring-purple-900/30',
  },
  messages: {
    bg: 'bg-green-50 dark:bg-green-900/20',
    icon: 'text-green-400 dark:text-green-500',
    ring: 'ring-4 ring-green-100/50 dark:ring-green-900/30',
  },
  search: {
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
    icon: 'text-yellow-500 dark:text-yellow-400',
    ring: 'ring-4 ring-yellow-100/50 dark:ring-yellow-900/30',
  },
};

export function EmptyState({ icon: Icon, title, description, action, illustration = 'default' }: EmptyStateProps) {
  const colors = illustrationColors[illustration] || illustrationColors.default;

  return (
    <div className="text-center py-16">
      <div className={`mx-auto w-20 h-20 rounded-full ${colors.bg} ${colors.ring} flex items-center justify-center mb-5 transition-colors`}>
        <Icon className={`w-9 h-9 ${colors.icon}`} />
      </div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
