// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Words for the health dot's colour (the `overallHealthColor` classes). The dot
 * alone is colour-only information, so the same verdict is carried as text for
 * screen readers and as the tooltip for everyone.
 */
const HEALTH_LABEL: Record<string, string> = {
  'bg-red-500': 'Quota critical',
  'bg-yellow-500': 'Approaching a quota limit',
  'bg-green-500': 'Quotas healthy',
};

/**
 * Sidebar list item for an organization, with a health-color indicator dot.
 * @param org - Organization identity (id, name, slug).
 * @param selected - Whether this org is currently selected.
 * @param healthColor - Tailwind background class for the health indicator dot.
 * @param onClick - Callback when the item is clicked.
 */
export function OrgListItem({
  org,
  selected,
  healthColor,
  onClick,
}: {
  org: { id: string; name: string; slug?: string };
  selected: boolean;
  healthColor?: string;
  onClick: () => void;
}) {
  const healthLabel = (healthColor && HEALTH_LABEL[healthColor]) || 'Quota health not loaded yet';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={`flex items-center gap-3 w-full text-left px-4 py-3 border-l-2 transition-colors ${
        selected
          ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500'
          : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${healthColor || 'bg-gray-300 dark:bg-gray-600'}`}
        title={healthLabel}
        aria-hidden="true"
      />
      <span className="sr-only">{healthLabel}:</span>
      <div className="min-w-0 flex-1">
        <div
          title={org.name}
          className={`text-sm truncate ${selected ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-fg-muted'}`}
        >
          {org.name}
        </div>
        {org.slug && <div className="text-xs text-fg-subtle font-mono truncate">{org.slug}</div>}
      </div>
    </button>
  );
}
