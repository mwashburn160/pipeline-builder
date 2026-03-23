/** Props for the RoleBanner component. */
interface RoleBannerProps {
  /** Whether the user is a system-level admin */
  isSysAdmin: boolean;
  /** Whether the user is an organization admin */
  isOrgAdmin: boolean;
  /** Whether the user has any admin role */
  isAdmin: boolean;
  /** Plural resource name shown in the banner message (e.g. "pipelines", "plugins") */
  resourceName: string;
  /** Organization name displayed for org admin context */
  orgName?: string;
}

const BANNER_STYLES: Record<string, string> = {
  purple: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200/60 dark:border-purple-800/60 text-purple-700 dark:text-purple-300',
  blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200/60 dark:border-blue-800/60 text-blue-700 dark:text-blue-300',
  gray: 'bg-gray-50 dark:bg-gray-800/50 border-gray-200/60 dark:border-gray-700/60 text-gray-700 dark:text-gray-300',
};

/** Contextual banner that indicates the user's access scope based on their role. */
export function RoleBanner({ isSysAdmin, isOrgAdmin, isAdmin, resourceName, orgName }: RoleBannerProps) {
  let color: string;
  let message: React.ReactNode;

  if (isSysAdmin) {
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

  return (
    <div className={`mb-6 rounded-xl p-4 border ${BANNER_STYLES[color]}`}>
      <p className="text-sm">{message}</p>
    </div>
  );
}
