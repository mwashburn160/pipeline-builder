import { FormSecurityGroupConfig } from '@/types/form-types';
import StringArrayEditor from './StringArrayEditor';

type SecurityGroupType = 'none' | 'securityGroupIds' | 'securityGroupLookup';

interface SecurityGroupEditorProps {
  securityGroupType: SecurityGroupType;
  securityGroup: FormSecurityGroupConfig;
  onTypeChange: (type: SecurityGroupType) => void;
  onSecurityGroupChange: (sg: FormSecurityGroupConfig) => void;
  disabled?: boolean;
}

export default function SecurityGroupEditor({
  securityGroupType, securityGroup, onTypeChange, onSecurityGroupChange, disabled,
}: SecurityGroupEditorProps) {
  const update = (fields: Partial<FormSecurityGroupConfig>) =>
    onSecurityGroupChange({ ...securityGroup, ...fields });

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Security Group Type</label>
        <select
          value={securityGroupType}
          onChange={(e) => onTypeChange(e.target.value as SecurityGroupType)}
          disabled={disabled}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="none">None</option>
          <option value="securityGroupIds">Security Group IDs</option>
          <option value="securityGroupLookup">Security Group Lookup</option>
        </select>
      </div>

      {securityGroupType === 'securityGroupIds' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200">
          <StringArrayEditor
            label="Security Group IDs *"
            value={securityGroup.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
          <div className="flex items-center">
            <input
              id="sgMutable"
              type="checkbox"
              checked={securityGroup.mutable}
              onChange={(e) => update({ mutable: e.target.checked })}
              disabled={disabled}
              className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
            />
            <label htmlFor="sgMutable" className="ml-2 text-sm text-gray-700">Mutable</label>
          </div>
        </div>
      )}

      {securityGroupType === 'securityGroupLookup' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Security Group Name *</label>
            <input
              type="text"
              value={securityGroup.securityGroupName}
              onChange={(e) => update({ securityGroupName: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">VPC ID *</label>
            <input
              type="text"
              value={securityGroup.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      )}
    </div>
  );
}
