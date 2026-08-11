import { FormBuilderState } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
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
          <Select
            value={role.type}
            onChange={(e) => onTypeChange(e.target.value as FormBuilderState['role']['type'])}
            disabled={disabled}
          >
            <option value="none">None</option>
            <option value="roleArn">Role ARN</option>
            <option value="roleName">Role Name</option>
            <option value="codeBuildDefault">CodeBuild Default</option>
            <option value="oidc">OIDC (GitHub Actions, GitLab CI, etc.)</option>
          </Select>
        </FormField>

        {role.type === 'roleArn' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role ARN *" error={errors['role.roleArn']}>
              <Input
                type="text"
                value={role.roleArn}
                onChange={(e) => onFieldChange('roleArn', e.target.value)}
                placeholder="arn:aws:iam::123456789:role/MyRole"
                disabled={disabled}
              />
            </FormField>
            <div className="flex items-center">
              <Checkbox
                id="roleArnMutable"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor="roleArnMutable" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'roleName' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role Name *" error={errors['role.roleName']}>
              <Input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="MyPipelineRole"
                disabled={disabled}
              />
            </FormField>
            <div className="flex items-center">
              <Checkbox
                id="roleNameMutable"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor="roleNameMutable" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'codeBuildDefault' && (
          <div className="pl-4 border-l-2 border-gray-200 dark:border-gray-700">
            <FormField label="Role Name (optional)">
              <Input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="Optional custom role name"
                disabled={disabled}
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
              <Input
                type="text"
                value={role.oidcProviderArn}
                onChange={(e) => onFieldChange('oidcProviderArn', e.target.value)}
                placeholder="arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
                disabled={disabled || !!role.oidcIssuer}
              />
            </FormField>

            <div className="text-center text-xs text-gray-400 dark:text-gray-500">— or —</div>

            <FormField label="Issuer URL">
              <Input
                type="text"
                value={role.oidcIssuer}
                onChange={(e) => onFieldChange('oidcIssuer', e.target.value)}
                placeholder="https://token.actions.githubusercontent.com"
                disabled={disabled || !!role.oidcProviderArn}
              />
            </FormField>

            <FormField label="Client IDs (comma-separated)">
              <Input
                type="text"
                value={role.oidcClientIds}
                onChange={(e) => onFieldChange('oidcClientIds', e.target.value)}
                placeholder="sts.amazonaws.com"
                disabled={disabled}
              />
            </FormField>

            <FormField label="Trust Policy Conditions (key=value, one per line)">
              <Textarea
                value={role.oidcConditions}
                onChange={(e) => onFieldChange('oidcConditions', e.target.value)}
                placeholder={"token.actions.githubusercontent.com:sub=repo:my-org/my-repo:ref:refs/heads/main\ntoken.actions.githubusercontent.com:aud=sts.amazonaws.com"}
                disabled={disabled}
                rows={3}
                className="font-mono text-xs"
              />
            </FormField>

            <FormField label="Role Name (optional)">
              <Input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="Optional custom role name"
                disabled={disabled}
              />
            </FormField>

            <FormField label="Description (optional)">
              <Input
                type="text"
                value={role.oidcDescription}
                onChange={(e) => onFieldChange('oidcDescription', e.target.value)}
                placeholder="OIDC role for GitHub Actions CI/CD"
                disabled={disabled}
              />
            </FormField>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
