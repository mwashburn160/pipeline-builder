import { FormSecurityGroupConfig } from '@/types/form-types';
import StringArrayEditor from './StringArrayEditor';

/** How the security group is specified. */
type SecurityGroupType = 'none' | 'securityGroupIds' | 'securityGroupLookup';

/** Props for {@link SecurityGroupEditor}. */
interface SecurityGroupEditorProps {
  /** Currently selected security group configuration strategy. */
  securityGroupType: SecurityGroupType;
  /** Current security group configuration values. */
  securityGroup: FormSecurityGroupConfig;
  /** Callback when the security group type selector changes. */
  onTypeChange: (type: SecurityGroupType) => void;
  /** Callback when any security group configuration field changes. */
  onSecurityGroupChange: (sg: FormSecurityGroupConfig) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Editor for security group configuration used by the pipeline defaults section.
 *
 * Supports two modes: explicit security group IDs (with mutable toggle) and
 * security group lookup by name and VPC ID.
 */
export default function SecurityGroupEditor({
  securityGroupType, securityGroup, onTypeChange, onSecurityGroupChange, disabled,
}: SecurityGroupEditorProps) {
  const update = (fields: Partial<FormSecurityGroupConfig>) =>
    onSecurityGroupChange({ ...securityGroup, ...fields });

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Security Group Type</label>
        <select
          value={securityGroupType}
          onChange={(e) => onTypeChange(e.target.value as SecurityGroupType)}
          disabled={disabled}
          className="input"
        >
          <option value="none">None</option>
          <option value="securityGroupIds">Security Group IDs</option>
          <option value="securityGroupLookup">Security Group Lookup</option>
        </select>
      </div>

      {securityGroupType === 'securityGroupIds' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
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
              className="h-4 w-4 text-blue-600 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
            />
            <label htmlFor="sgMutable" className="ml-2 text-sm text-gray-700 dark:text-gray-300">Mutable</label>
          </div>
        </div>
      )}

      {securityGroupType === 'securityGroupLookup' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <div>
            <label className="label">Security Group Name *</label>
            <input
              type="text"
              value={securityGroup.securityGroupName}
              onChange={(e) => update({ securityGroupName: e.target.value })}
              disabled={disabled}
              className="input"
            />
          </div>
          <div>
            <label className="label">VPC ID *</label>
            <input
              type="text"
              value={securityGroup.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
              className="input"
            />
          </div>
        </div>
      )}
    </div>
  );
}
