import { FormBuilderState, FormNetworkConfig, FormSecurityGroupConfig, MetadataEntry } from '@/types/form-types';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import SecurityGroupEditor from '../editors/SecurityGroupEditor';
import MetadataEditor from '../editors/MetadataEditor';
import CollapsibleSection from '../editors/CollapsibleSection';

interface DefaultsSectionProps {
  defaults: FormBuilderState['defaults'];
  onEnabledChange: (enabled: boolean) => void;
  onNetworkTypeChange: (type: FormBuilderState['defaults']['networkType']) => void;
  onNetworkChange: (network: FormNetworkConfig) => void;
  onSGTypeChange: (type: FormBuilderState['defaults']['securityGroupType']) => void;
  onSGChange: (sg: FormSecurityGroupConfig) => void;
  onMetadataChange: (metadata: MetadataEntry[]) => void;
  disabled?: boolean;
}

export default function DefaultsSection({
  defaults,
  onEnabledChange, onNetworkTypeChange, onNetworkChange,
  onSGTypeChange, onSGChange, onMetadataChange,
  disabled,
}: DefaultsSectionProps) {
  const hasContent = defaults.enabled && (
    defaults.networkType !== 'none' ||
    defaults.securityGroupType !== 'none' ||
    defaults.metadata.length > 0
  );

  return (
    <CollapsibleSection title="Pipeline Defaults" hasContent={hasContent}>
      <div className="mt-3 space-y-4">
        <div className="flex items-center">
          <input
            id="defaultsEnabled"
            type="checkbox"
            checked={defaults.enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            disabled={disabled}
            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
          />
          <label htmlFor="defaultsEnabled" className="ml-2 text-sm text-gray-700">
            Configure pipeline-level CodeBuild defaults
          </label>
        </div>

        {defaults.enabled && (
          <div className="space-y-4 pl-4 border-l-2 border-blue-200">
            <CollapsibleSection title="Network" hasContent={defaults.networkType !== 'none'}>
              <div className="mt-3">
                <NetworkConfigEditor
                  networkType={defaults.networkType}
                  network={defaults.network}
                  onTypeChange={onNetworkTypeChange}
                  onNetworkChange={onNetworkChange}
                  disabled={disabled}
                />
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Security Groups" hasContent={defaults.securityGroupType !== 'none'}>
              <div className="mt-3">
                <SecurityGroupEditor
                  securityGroupType={defaults.securityGroupType}
                  securityGroup={defaults.securityGroup}
                  onTypeChange={onSGTypeChange}
                  onSecurityGroupChange={onSGChange}
                  disabled={disabled}
                />
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Metadata" hasContent={defaults.metadata.length > 0}>
              <div className="mt-3">
                <MetadataEditor
                  value={defaults.metadata}
                  onChange={onMetadataChange}
                  disabled={disabled}
                />
              </div>
            </CollapsibleSection>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
