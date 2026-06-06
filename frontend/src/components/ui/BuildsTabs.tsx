import Link from 'next/link';

/**
 * Segmented tabs linking the two sysadmin plugin-build views — the live queue
 * and the failed-build (DLQ) triage. They used to be two separate nav items;
 * now they're one "Builds" entry with these tabs to switch between them.
 */
const TABS = [
  { key: 'queue', label: 'Queue', href: '/dashboard/build-queue' },
  { key: 'failed', label: 'Failed / Triage', href: '/dashboard/triage' },
] as const;

export function BuildsTabs({ active }: { active: 'queue' | 'failed' }) {
  return (
    <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
            active === t.key
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
