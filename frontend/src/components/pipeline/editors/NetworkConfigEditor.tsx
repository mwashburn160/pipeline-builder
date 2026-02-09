import { FormNetworkConfig, TagEntry } from '@/types/form-types';
import StringArrayEditor from './StringArrayEditor';

type NetworkType = 'none' | 'subnetIds' | 'vpcId' | 'vpcLookup';

interface NetworkConfigEditorProps {
  networkType: NetworkType;
  network: FormNetworkConfig;
  onTypeChange: (type: NetworkType) => void;
  onNetworkChange: (network: FormNetworkConfig) => void;
  disabled?: boolean;
}

export default function NetworkConfigEditor({
  networkType, network, onTypeChange, onNetworkChange, disabled,
}: NetworkConfigEditorProps) {
  const update = (fields: Partial<FormNetworkConfig>) => onNetworkChange({ ...network, ...fields });

  const handleTagChange = (index: number, field: 'key' | 'value', val: string) => {
    const tags = [...network.tags];
    tags[index] = { ...tags[index], [field]: val };
    update({ tags });
  };

  const addTag = () => update({ tags: [...network.tags, { key: '', value: '' }] });
  const removeTag = (index: number) => update({ tags: network.tags.filter((_, i) => i !== index) });

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Network Type</label>
        <select
          value={networkType}
          onChange={(e) => onTypeChange(e.target.value as NetworkType)}
          disabled={disabled}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
        >
          <option value="none">None</option>
          <option value="subnetIds">Subnet IDs</option>
          <option value="vpcId">VPC by ID</option>
          <option value="vpcLookup">VPC by Tag Lookup</option>
        </select>
      </div>

      {networkType === 'subnetIds' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">VPC ID *</label>
            <input
              type="text"
              value={network.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
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
            label="Security Group IDs"
            value={network.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
        </div>
      )}

      {networkType === 'vpcId' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">VPC ID *</label>
            <input
              type="text"
              value={network.vpcId}
              onChange={(e) => update({ vpcId: e.target.value })}
              placeholder="vpc-..."
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subnet Type</label>
            <select
              value={network.subnetType}
              onChange={(e) => update({ subnetType: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="PRIVATE_WITH_EGRESS">Private with Egress</option>
              <option value="PRIVATE_WITH_NAT">Private with NAT</option>
              <option value="PRIVATE_ISOLATED">Private Isolated</option>
              <option value="PUBLIC">Public</option>
            </select>
          </div>
          <StringArrayEditor
            label="Availability Zones"
            value={network.availabilityZones}
            onChange={(availabilityZones) => update({ availabilityZones })}
            placeholder="us-east-1a"
            disabled={disabled}
            addLabel="+ Add AZ"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subnet Group Name</label>
            <input
              type="text"
              value={network.subnetGroupName}
              onChange={(e) => update({ subnetGroupName: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <StringArrayEditor
            label="Security Group IDs"
            value={network.securityGroupIds}
            onChange={(securityGroupIds) => update({ securityGroupIds })}
            placeholder="sg-..."
            disabled={disabled}
            addLabel="+ Add Security Group"
          />
        </div>
      )}

      {networkType === 'vpcLookup' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Tags *</label>
            <div className="space-y-2">
              {network.tags.map((tag: TagEntry, idx: number) => (
                <div key={idx} className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={tag.key}
                    onChange={(e) => handleTagChange(idx, 'key', e.target.value)}
                    placeholder="Tag Key"
                    disabled={disabled}
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                  <input
                    type="text"
                    value={tag.value}
                    onChange={(e) => handleTagChange(idx, 'value', e.target.value)}
                    placeholder="Tag Value"
                    disabled={disabled}
                    className="flex-1 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => removeTag(idx)}
                    disabled={disabled}
                    className="text-red-500 hover:text-red-700 text-sm px-2 py-1"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addTag}
              disabled={disabled}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              + Add Tag
            </button>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">VPC Name</label>
            <input
              type="text"
              value={network.vpcName}
              onChange={(e) => update({ vpcName: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Region</label>
            <input
              type="text"
              value={network.region}
              onChange={(e) => update({ region: e.target.value })}
              placeholder="us-east-1"
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subnet Type</label>
            <select
              value={network.subnetType}
              onChange={(e) => update({ subnetType: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="PRIVATE_WITH_EGRESS">Private with Egress</option>
              <option value="PRIVATE_WITH_NAT">Private with NAT</option>
              <option value="PRIVATE_ISOLATED">Private Isolated</option>
              <option value="PUBLIC">Public</option>
            </select>
          </div>
          <StringArrayEditor
            label="Availability Zones"
            value={network.availabilityZones}
            onChange={(availabilityZones) => update({ availabilityZones })}
            placeholder="us-east-1a"
            disabled={disabled}
            addLabel="+ Add AZ"
          />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Subnet Group Name</label>
            <input
              type="text"
              value={network.subnetGroupName}
              onChange={(e) => update({ subnetGroupName: e.target.value })}
              disabled={disabled}
              className="block w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <StringArrayEditor
            label="Security Group IDs"
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
