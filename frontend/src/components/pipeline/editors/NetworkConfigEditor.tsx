import { useRef, useId } from 'react';
import { FormNetworkConfig, TagEntry } from '@/types/form-types';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import StringArrayEditor from './StringArrayEditor';

/** How the VPC/network is specified. */
type NetworkType = 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';

/** Props for {@link NetworkConfigEditor}. */
interface NetworkConfigEditorProps {
  /** Currently selected network configuration strategy. */
  networkType: NetworkType;
  /** Current network configuration values (VPC ID, subnets, tags, etc.). */
  network: FormNetworkConfig;
  /** Callback when the network type selector changes. */
  onTypeChange: (type: NetworkType) => void;
  /** Callback when any network configuration field changes. */
  onNetworkChange: (network: FormNetworkConfig) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Editor for VPC/network configuration used by synth, defaults, and step sections.
 *
 * Supports three network modes: direct subnet IDs, VPC by ID (with subnet type selection),
 * and VPC by tag lookup (with region, name, and tag key-value pairs).
 * Each mode reveals the relevant fields for that configuration strategy.
 */
export default function NetworkConfigEditor({
  networkType, network, onTypeChange, onNetworkChange, disabled,
}: NetworkConfigEditorProps) {
  const uid = useId();
  const update = (fields: Partial<FormNetworkConfig>) => onNetworkChange({ ...network, ...fields });

  // Stable, client-only ids for the free-text tag rows, kept in lockstep with
  // network.tags so React keys by row identity (not index). Never serialized —
  // the tags written back through `update` carry only key/value.
  const counterRef = useRef(0);
  const tagIdsRef = useRef<string[]>([]);
  while (tagIdsRef.current.length < network.tags.length) tagIdsRef.current.push(`tag-${counterRef.current++}`);
  if (tagIdsRef.current.length > network.tags.length) tagIdsRef.current = tagIdsRef.current.slice(0, network.tags.length);
  const tagIds = tagIdsRef.current;

  const handleTagChange = (index: number, field: 'key' | 'value', val: string) => {
    const tags = [...network.tags];
    tags[index] = { ...tags[index], [field]: val };
    update({ tags });
  };

  const addTag = () => update({ tags: [...network.tags, { key: '', value: '' }] });
  const removeTag = (index: number) => {
    tagIdsRef.current = tagIdsRef.current.filter((_, i) => i !== index);
    update({ tags: network.tags.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor={`${uid}-network-type`}>Network type</label>
        <Select
          id={`${uid}-network-type`}
          value={networkType}
          onChange={(e) => onTypeChange(e.target.value as NetworkType)}
          disabled={disabled}
        >
          <option value="none">None</option>
          <option value="subnetIds">Subnet IDs</option>
          <option value="vpcId">VPC by ID</option>
          <option value="vpcLookup">VPC by Tag Lookup</option>
        </Select>
      </div>

      {networkType === 'subnetIds' && (
        <div className="space-y-3 pl-4 border-l-2 border-default">
          <div>
            <label className="label" htmlFor={`${uid}-vpc-id`}>VPC ID *</label>
            <Input
              id={`${uid}-vpc-id`}
              type="text"
              value={network.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
            />
          </div>
          <StringArrayEditor
            label="Subnet IDs *"
            value={network.subnetIds}
            onChange={(subnetIds) => update({ subnetIds })}
            placeholder="subnet-..."
            disabled={disabled}
            addLabel="+ Add Subnet"
          />
          <StringArrayEditor
            label="Security group IDs"
            value={network.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
        </div>
      )}

      {networkType === 'vpcId' && (
        <div className="space-y-3 pl-4 border-l-2 border-default">
          <div>
            <label className="label" htmlFor={`${uid}-vpc-id-2`}>VPC ID *</label>
            <Input
              id={`${uid}-vpc-id-2`}
              type="text"
              value={network.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-subnet-type`}>Subnet type</label>
            <Select
              id={`${uid}-subnet-type`}
              value={network.subnetType}
              onChange={(e) => update({ subnetType: e.target.value })}
              disabled={disabled}
            >
              <option value="PRIVATE_WITH_EGRESS">Private with Egress</option>
              <option value="PRIVATE_WITH_NAT">Private with NAT</option>
              <option value="PRIVATE_ISOLATED">Private Isolated</option>
              <option value="PUBLIC">Public</option>
            </Select>
          </div>
          <StringArrayEditor
            label="Availability zones"
            value={network.availabilityZones}
            onChange={(availabilityZones) => update({ availabilityZones })}
            placeholder="us-east-1a"
            disabled={disabled}
            addLabel="+ Add AZ"
          />
          <div>
            <label className="label" htmlFor={`${uid}-subnet-group-name`}>Subnet group name</label>
            <Input
              id={`${uid}-subnet-group-name`}
              type="text"
              value={network.subnetGroupName}
              onChange={(e) => update({ subnetGroupName: e.target.value })}
              disabled={disabled}
            />
          </div>
          <StringArrayEditor
            label="Security group IDs"
            value={network.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
        </div>
      )}

      {networkType === 'vpcLookup' && (
        <div className="space-y-3 pl-4 border-l-2 border-default">
          <div>
            <span className="label" id={`${uid}-tags`}>Tags *</span>
            <div role="group" aria-labelledby={`${uid}-tags`} className="space-y-2">
              {network.tags.map((tag: TagEntry, idx: number) => (
                <div key={tagIds[idx]} className="flex items-center space-x-2">
                  <Input
                    type="text"
                    value={tag.key}
                    onChange={(e) => handleTagChange(idx, 'key', e.target.value)}
                    placeholder="Tag Key"
                    disabled={disabled}
                    className="flex-1"
                  />
                  <Input
                    type="text"
                    value={tag.value}
                    onChange={(e) => handleTagChange(idx, 'value', e.target.value)}
                    placeholder="Tag Value"
                    disabled={disabled}
                    className="flex-1"
                  />
                  <Button
                    variant="link"
                    onClick={() => removeTag(idx)}
                    disabled={disabled}
                    className="text-danger hover:text-danger text-sm"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button
              variant="link"
              onClick={addTag}
              disabled={disabled}
              className="mt-2 text-sm"
            >
              + Add Tag
            </Button>
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-vpc-name`}>VPC Name</label>
            <Input
              id={`${uid}-vpc-name`}
              type="text"
              value={network.vpcName}
              onChange={(e) => update({ vpcName: e.target.value })}
              disabled={disabled}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-region`}>Region</label>
            <Input
              id={`${uid}-region`}
              type="text"
              value={network.region}
              onChange={(e) => update({ region: e.target.value })}
              placeholder="us-east-1"
              disabled={disabled}
            />
          </div>
          <div>
            <label className="label" htmlFor={`${uid}-subnet-type-2`}>Subnet type</label>
            <Select
              id={`${uid}-subnet-type-2`}
              value={network.subnetType}
              onChange={(e) => update({ subnetType: e.target.value })}
              disabled={disabled}
            >
              <option value="PRIVATE_WITH_EGRESS">Private with Egress</option>
              <option value="PRIVATE_WITH_NAT">Private with NAT</option>
              <option value="PRIVATE_ISOLATED">Private Isolated</option>
              <option value="PUBLIC">Public</option>
            </Select>
          </div>
          <StringArrayEditor
            label="Availability zones"
            value={network.availabilityZones}
            onChange={(availabilityZones) => update({ availabilityZones })}
            placeholder="us-east-1a"
            disabled={disabled}
            addLabel="+ Add AZ"
          />
          <div>
            <label className="label" htmlFor={`${uid}-subnet-group-name-2`}>Subnet group name</label>
            <Input
              id={`${uid}-subnet-group-name-2`}
              type="text"
              value={network.subnetGroupName}
              onChange={(e) => update({ subnetGroupName: e.target.value })}
              disabled={disabled}
            />
          </div>
          <StringArrayEditor
            label="Security group IDs"
            value={network.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
        </div>
      )}
    </div>
  );
}
