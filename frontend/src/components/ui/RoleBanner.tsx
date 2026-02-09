interface RoleBannerProps {
  isSysAdmin: boolean;
  isOrgAdmin: boolean;
  isAdmin: boolean;
  resourceName: string;
  orgName?: string;
}

export function RoleBanner({ isSysAdmin, isOrgAdmin, isAdmin, resourceName, orgName }: RoleBannerProps) {
  if (isSysAdmin) {
    return (
      <div className="mb-6 rounded-xl bg-purple-50 dark:bg-purple-900/20 p-4 border border-purple-200/60 dark:border-purple-800/60">
        <p className="text-sm text-purple-700 dark:text-purple-300">
          System Admin: Viewing all {resourceName} across all organizations.
        </p>
      </div>
    );
  }

  if (isOrgAdmin) {
    return (
      <div className="mb-6 rounded-xl bg-blue-50 dark:bg-blue-900/20 p-4 border border-blue-200/60 dark:border-blue-800/60">
        <p className="text-sm text-blue-700 dark:text-blue-300">
          Organization Admin: Viewing and managing {resourceName} for <strong>{orgName || 'your organization'}</strong> only.
        </p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mb-6 rounded-xl bg-gray-50 dark:bg-gray-800/50 p-4 border border-gray-200/60 dark:border-gray-700/60">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          Viewing private {resourceName} for your organization.
        </p>
      </div>
    );
  }

  return null;
}
