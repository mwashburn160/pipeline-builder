import { FormBuilderState } from '@/types/form-types';
import CollapsibleSection from '../editors/CollapsibleSection';

interface RoleSectionProps {
  role: FormBuilderState['role'];
  onTypeChange: (type: FormBuilderState['role']['type']) => void;
  onFieldChange: (field: 'roleArn' | 'roleName', value: string) => void;
  onMutableChange: (mutable: boolean) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

export default function RoleSection({
  role, onTypeChange, onFieldChange, onMutableChange, disabled, errors = {},
}: RoleSectionProps) {
  return (
    <CollapsibleSection title="IAM Role" hasContent={role.type !== 'none'}>
      <div className="mt-3 space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Role Type</label>
          <select
            value={role.type}
            onChange={(e) => onTypeChange(e.target.value as FormBuilderState['role']['type'])}
            disabled={disabled}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="none">None</option>
            <option value="roleArn">Role ARN</option>
            <option value="roleName">Role Name</option>
            <option value="codeBuildDefault">CodeBuild Default</option>
          </select>
        </div>

        {role.type === 'roleArn' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role ARN *</label>
              <input
                type="text"
                value={role.roleArn}
                onChange={(e) => onFieldChange('roleArn', e.target.value)}
                placeholder="arn:aws:iam::123456789:role/MyRole"
                disabled={disabled}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
              {errors['role.roleArn'] && <p className="mt-1 text-xs text-red-600">{errors['role.roleArn']}</p>}
            </div>
            <div className="flex items-center">
              <input
                id="roleArnMutable"
                type="checkbox"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label htmlFor="roleArnMutable" className="ml-2 text-sm text-gray-700">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'roleName' && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-200">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role Name *</label>
              <input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="MyPipelineRole"
                disabled={disabled}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
              {errors['role.roleName'] && <p className="mt-1 text-xs text-red-600">{errors['role.roleName']}</p>}
            </div>
            <div className="flex items-center">
              <input
                id="roleNameMutable"
                type="checkbox"
                checked={role.mutable}
                onChange={(e) => onMutableChange(e.target.checked)}
                disabled={disabled}
                className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label htmlFor="roleNameMutable" className="ml-2 text-sm text-gray-700">Mutable</label>
            </div>
          </div>
        )}

        {role.type === 'codeBuildDefault' && (
          <div className="pl-4 border-l-2 border-gray-200">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role Name (optional)</label>
              <input
                type="text"
                value={role.roleName}
                onChange={(e) => onFieldChange('roleName', e.target.value)}
                placeholder="Optional custom role name"
                disabled={disabled}
                className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
