/**
 * Props for the RoleBanner component.
 *
 * WHAT THIS BANNER IS FOR, after the Role model settled: warning a platform
 * operator that what they are looking at spans every tenant. That is a fact
 * about SCOPE, it is true, and it is not visible from the data itself.
 *
 * It used to render two more messages, derived from `isOrgAdmin` / `isAdmin`:
 * "Organization Admin: Viewing and managing {resource}" and "Viewing private
 * {resource} for your organization". Both inferred CAPABILITY from the coarse
 * role label — the one field that grants nothing, since permissions come only
 * from the Roles assigned to a person. On `/dashboard/roles`, whose gate is
 * `roles:manage` and not the admin label, a non-admin holding that permission
 * was told they were merely "viewing private roles". The member message was
 * wrong about the data too: the visibility ladder shows a member private,
 * org-visible AND public entities, not only private ones.
 *
 * So the two capability claims are gone rather than restated per page. A page
 * that needs to say what the viewer may do says it on the control.
 */
interface RoleBannerProps {
  /** Whether the user is a system-level admin — the only case this renders. */
  isSuperAdmin: boolean;
  /** Plural resource name shown in the banner message (e.g. "pipelines", "plugins") */
  resourceName: string;
  /** Visual size, matching the rest of the primitive UI library. */
  size?: 'sm' | 'md' | 'lg';
  /** Extra classes appended to the root container. */
  className?: string;
}

const BANNER_STYLE =
  'bg-purple-50 dark:bg-purple-900/20 border-purple-200/60 dark:border-purple-800/60 text-purple-700 dark:text-purple-300';

const SIZE_CLASSES: Record<NonNullable<RoleBannerProps['size']>, { container: string; text: string }> = {
  sm: { container: 'p-3', text: 'text-xs' },
  md: { container: 'p-4', text: 'text-sm' },
  lg: { container: 'p-5', text: 'text-base' },
};

/**
 * Cross-tenant scope warning. Renders for a platform operator and nobody else —
 * for every other viewer the list already shows exactly what they may see, and
 * a banner restating their role label told them nothing they could act on.
 */
export function RoleBanner({
  isSuperAdmin,
  resourceName,
  size = 'md',
  className = '',
}: RoleBannerProps) {
  if (!isSuperAdmin) return null;

  const sizeClasses = SIZE_CLASSES[size];

  return (
    <div className={`mb-6 rounded-xl border ${sizeClasses.container} ${BANNER_STYLE} ${className}`}>
      <p className={sizeClasses.text}>
        System Admin: Viewing all {resourceName} across all organizations.
      </p>
    </div>
  );
}
