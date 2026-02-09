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
      <div className="mb-6 rounded-md bg-purple-50 p-4">
        <p className="text-sm text-purple-700">
          System Admin: Viewing all {resourceName} across all organizations.
        </p>
      </div>
    );
  }

  if (isOrgAdmin) {
    return (
      <div className="mb-6 rounded-md bg-blue-50 p-4">
        <p className="text-sm text-blue-700">
          Organization Admin: Viewing and managing {resourceName} for <strong>{orgName || 'your organization'}</strong> only.
        </p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mb-6 rounded-md bg-gray-50 p-4">
        <p className="text-sm text-gray-700">
          Viewing private {resourceName} for your organization.
        </p>
      </div>
    );
  }

  return null;
}
