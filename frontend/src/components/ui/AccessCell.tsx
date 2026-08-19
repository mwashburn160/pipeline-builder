import { Lock } from 'lucide-react';

/**
 * Access-modifier table cell. `public` is the common case → muted grey text;
 * `private` is the exception → legible with a lock, so the eye catches what
 * actually differs. Shared by the pipelines/plugins tables.
 */
export function AccessCell({ modifier }: { modifier: string }) {
  return modifier === 'public'
    ? <span className="text-xs text-gray-400 dark:text-gray-500">Public</span>
    : (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300">
        <Lock className="h-3 w-3" />Private
      </span>
    );
}
