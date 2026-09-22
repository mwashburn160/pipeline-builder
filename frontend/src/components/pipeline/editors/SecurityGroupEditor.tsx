import { FormSecurityGroupConfig } from '@/types/form-types';
import { useId } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Checkbox } from '@/components/ui/Checkbox';
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
  const uid = useId();
  const update = (fields: Partial<FormSecurityGroupConfig>) =>
    onSecurityGroupChange({ ...securityGroup, ...fields });

  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor={`${uid}-security-group-type`}>Security group type</label>
        <Select
          id={`${uid}-security-group-type`}
          value={securityGroupType}
          onChange={(e) => onTypeChange(e.target.value as SecurityGroupType)}
          disabled={disabled}
        >
          <option value="none">None</option>
          <option value="securityGroupIds">Security group IDs</option>
          <option value="securityGroupLookup">Security group lookup</option>
        </Select>
      </div>

      {securityGroupType === 'securityGroupIds' && (
        <div className="space-y-3 pl-4 border-l-2 border-default">
          <StringArrayEditor
            label="Security group IDs *"
            value={securityGroup.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
          <div className="flex items-center">
            <Checkbox
              id="sgMutable"
              checked={securityGroup.mutable}
              onChange={(e) => update({ mutable: e.target.checked })}
              disabled={disabled}
              className="h-4 w-4 text-brand focus:ring-[color:var(--pb-ring)]"
            />
            <label htmlFor="sgMutable" className="ml-2 text-sm text-fg-muted">Mutable</label>
          </div>
        </div>
      )}

      {securityGroupType === 'securityGroupLookup' && (
        <div className="space-y-3 pl-4 border-l-2 border-default">
          <div>
            <label className="label" htmlFor={`${uid}-security-group-name`}>Security group name *</label>
            <Input
              id={`${uid}-security-group-name`}
              type="text"
              value={securityGroup.securityGroupName}
              onChange={(e) => update({ securityGroupName: e.target.value })}
              disabled={disabled}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-vpc-id`}>VPC ID *</label>
            <Input
              id={`${uid}-vpc-id`}
              type="text"
              value={securityGroup.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
}
