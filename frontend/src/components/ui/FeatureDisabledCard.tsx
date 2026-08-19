import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from './Card';

interface FeatureDisabledCardProps {
  /** Optional icon well above the title (omit for the leaner variant). */
  icon?: LucideIcon;
  title: string;
  /** Description body — may contain `<code>` env-var hints. */
  children: ReactNode;
}

/**
 * Centered "&lt;feature&gt; is not enabled" card shown when a tier/deployment flag
 * is off. Shared by discounts / promotions / billing so the empty-disabled
 * state reads consistently.
 */
export function FeatureDisabledCard({ icon: Icon, title, children }: FeatureDisabledCardProps) {
  return (
    <Card className="flex flex-col items-center text-center py-14">
      {Icon && (
        <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-700/50 flex items-center justify-center">
          <Icon className="w-9 h-9 text-gray-400 dark:text-gray-500" />
        </div>
      )}
      <h3 className={`${Icon ? 'mt-4 ' : ''}text-base font-semibold text-gray-900 dark:text-gray-100`}>{title}</h3>
      <p className="mt-1.5 text-sm text-gray-500 dark:text-gray-400 max-w-sm">{children}</p>
    </Card>
  );
}
