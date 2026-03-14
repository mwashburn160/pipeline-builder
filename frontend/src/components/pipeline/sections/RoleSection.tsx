import { FormBuilderState } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';
import CollapsibleSection from '../editors/CollapsibleSection';

/** Props for {@link RoleSection}. */
interface RoleSectionProps {
  role: FormBuilderState['role'];
  onTypeChange: (type: FormBuilderState['role']['type']) => void;
  onFieldChange: (field: 'roleArn' | 'roleName' | 'oidcProviderArn' | 'oidcIssuer' | 'oidcClientIds' | 'oidcConditions' | 'oidcDescription', value: string) => void;
  onMutableChange: (mutable: boolean) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

/**
 * Collapsible section for configuring the IAM role used by the pipeline.
 *
 * Supports five modes: none, explicit role ARN, role by name,
 * CodeBuild default role, and OIDC federated role (e.g. GitHub Actions).
 */
export default function RoleSection({
  role, onTypeChange, onFieldChange, onMutableChange, disabled, errors = {},
}: RoleSectionProps) {
  return (
    <CollapsibleSection title="IAM Role" hasContent={role.type !== 'none'}>
      <div className="mt-3 space-y-3">
        <FormField label="Role Type">
          <select
            value={role.type}
            onChange={(e) => onTypeChange(e.target.value as FormBuilderState['role']['type'])}
            disabled={disabled}
            className="input"
          >
            <option value="none">None</option>
            <option value="roleArn">Role ARN</option>
            <option value="roleName">Role Name</option>
            <option value="codeBuildDefault">CodeBuild Default</option>
            <option value="oidc">OIDC (GitHub Actions, GitLab CI, etc.)</option>
          </select>
        </FormField>

        {role.type === 'roleArn' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role ARN *" error={errors['role.roleArn']}>
              <input
                type="text"
                value={role.roleArn}
                onChange={(e) => onFieldChange('roleArn', e.target.value)}
                placeholder="arn:aws:iam::123456789:role/MyRole"
                disabled={disabled}
                className="input"
              />
            </FormField>
            <div className="flex items-center">
              <input
                id="roleArnMutable"
                type="checkbox"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
              />
              <label htmlFor="roleArnMutable" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'roleName' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role Name *" error={errors['role.roleName']}>
              <input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="MyPipelineRole"
                disabled={disabled}
                className="input"
              />
            </FormField>
            <div className="flex items-center">
              <input
                id="roleNameMutable"
                type="checkbox"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
              />
              <label htmlFor="roleNameMutable" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'codeBuildDefault' && (
          <div className="pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role Name (optional)">
              <input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="Optional custom role name"
                disabled={disabled}
                className="input"
              />
            </FormField>
          </div>
        )}

        {role.type === 'oidc' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Create a role trusted by an OIDC identity provider (e.g. GitHub Actions, GitLab CI).
              Provide either an existing provider ARN or an issuer URL to create a new one.
            </p>

            <FormField label="Provider ARN" error={errors['role.oidcProviderArn']}>
              <input
                type="text"
                value={role.oidcProviderArn}
                onChange={(e) => onFieldChange('oidcProviderArn', e.target.value)}
                placeholder="arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
                disabled={disabled || !!role.oidcIssuer}
                className="input"
              />
            </FormField>

            <div className="text-center text-xs text-gray-400 dark:text-gray-500">— or —</div>

            <FormField label="Issuer URL">
              <input
                type="text"
                value={role.oidcIssuer}
                onChange={(e) => onFieldChange('oidcIssuer', e.target.value)}
                placeholder="https://token.actions.githubusercontent.com"
                disabled={disabled || !!role.oidcProviderArn}
                className="input"
              />
            </FormField>

            <FormField label="Client IDs (comma-separated)">
              <input
                type="text"
                value={role.oidcClientIds}
                onChange={(e) => onFieldChange('oidcClientIds', e.target.value)}
                placeholder="sts.amazonaws.com"
                disabled={disabled}
                className="input"
              />
            </FormField>

            <FormField label="Trust Policy Conditions (key=value, one per line)">
              <textarea
                value={role.oidcConditions}
                onChange={(e) => onFieldChange('oidcConditions', e.target.value)}
                placeholder={"token.actions.githubusercontent.com:sub=repo:my-org/my-repo:ref:refs/heads/main\ntoken.actions.githubusercontent.com:aud=sts.amazonaws.com"}
                disabled={disabled}
                rows={3}
                className="input font-mono text-xs"
              />
            </FormField>

            <FormField label="Role Name (optional)">
              <input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="Optional custom role name"
                disabled={disabled}
                className="input"
              />
            </FormField>

            <FormField label="Description (optional)">
              <input
                type="text"
                value={role.oidcDescription}
                onChange={(e) => onFieldChange('oidcDescription', e.target.value)}
                placeholder="OIDC role for GitHub Actions CI/CD"
                disabled={disabled}
                className="input"
              />
            </FormField>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
