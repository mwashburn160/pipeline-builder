/** Props for the RoleBanner component. */
interface RoleBannerProps {
  /** Whether the user is a system-level admin */
  isSuperAdmin: boolean;
  /** Whether the user is an organization admin */
  isOrgAdmin: boolean;
  /** Whether the user has any admin role */
  isAdmin: boolean;
  /** Plural resource name shown in the banner message (e.g. "pipelines", "plugins") */
  resourceName: string;
  /** Organization name displayed for org admin context */
  orgName?: string;
  /** Visual size, matching the rest of the primitive UI library. */
  size?: 'sm' | 'md' | 'lg';
  /** Extra classes appended to the root container. */
  className?: string;
}

const BANNER_STYLES: Record<string, string> = {
  purple: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200/60 dark:border-purple-800/60 text-purple-700 dark:text-purple-300',
  blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200/60 dark:border-blue-800/60 text-blue-700 dark:text-blue-300',
  gray: 'bg-gray-50 dark:bg-gray-800/50 border-gray-200/60 dark:border-gray-700/60 text-gray-700 dark:text-gray-300',
};

const SIZE_CLASSES: Record<NonNullable<RoleBannerProps['size']>, { container: string; text: string }> = {
  sm: { container: 'p-3', text: 'text-xs' },
  md: { container: 'p-4', text: 'text-sm' },
  lg: { container: 'p-5', text: 'text-base' },
};

/** Contextual banner that indicates the user's access scope based on their role. */
export function RoleBanner({
  isSuperAdmin,
  isOrgAdmin,
  isAdmin,
  resourceName,
  orgName,
  size = 'md',
  className = '',
}: RoleBannerProps) {
  let color: string;
  let message: React.ReactNode;

  if (isSuperAdmin) {
    color = 'purple';
    message = <>System Admin: Viewing all {resourceName} across all organizations.</>;
  } else if (isOrgAdmin) {
    color = 'blue';
    message = <>Organization Admin: Viewing and managing {resourceName} for <strong>{orgName || 'your organization'}</strong> only.</>;
  } else if (!isAdmin) {
    color = 'gray';
    message = <>Viewing private {resourceName} for your organization.</>;
  } else {
    return null;
  }

  const sizeClasses = SIZE_CLASSES[size];

  return (
    <div className={`mb-6 rounded-xl border ${sizeClasses.container} ${BANNER_STYLES[color]} ${className}`}>
      <p className={sizeClasses.text}>{message}</p>
    </div>
  );
}
