import { type LucideIcon } from 'lucide-react';

/** Props for the EmptyState component. */
interface EmptyStateProps {
  /** Lucide icon displayed in the circular background */
  icon: LucideIcon;
  /** Heading text below the icon */
  title: string;
  /** Descriptive text explaining why the state is empty */
  description: string;
  /** Optional call-to-action element (e.g. a button to create the first item) */
  action?: React.ReactNode;
}

/** Centered placeholder shown when a list or section has no data. */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="text-center py-16">
      <div className="mx-auto w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-gray-400 dark:text-gray-500" />
      </div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-sm mx-auto">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
