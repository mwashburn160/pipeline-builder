import { FormBuilderState, FormNetworkConfig, FormSecurityGroupConfig, MetadataEntry } from '@/types/form-types';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import SecurityGroupEditor from '../editors/SecurityGroupEditor';
import MetadataEditor from '../editors/MetadataEditor';
import CollapsibleSection from '../editors/CollapsibleSection';

/** Props for {@link DefaultsSection}. */
interface DefaultsSectionProps {
  /** Current pipeline defaults state (enabled flag, network, security groups, metadata). */
  defaults: FormBuilderState['defaults'];
  /** Callback when the "enabled" checkbox toggles. */
  onEnabledChange: (enabled: boolean) => void;
  /** Callback when the network type selector changes. */
  onNetworkTypeChange: (type: FormBuilderState['defaults']['networkType']) => void;
  /** Callback when any network configuration field changes. */
  onNetworkChange: (network: FormNetworkConfig) => void;
  /** Callback when the security group type selector changes. */
  onSGTypeChange: (type: FormBuilderState['defaults']['securityGroupType']) => void;
  /** Callback when any security group configuration field changes. */
  onSGChange: (sg: FormSecurityGroupConfig) => void;
  /** Callback when the defaults metadata entries change. */
  onMetadataChange: (metadata: MetadataEntry[]) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Collapsible section for configuring pipeline-level CodeBuild defaults.
 *
 * When enabled, exposes sub-sections for network configuration, security groups,
 * and metadata that apply as defaults to all pipeline steps.
 */
/** Look up a metadata entry by key. */
function getMetaValue(entries: MetadataEntry[], key: string): string | undefined {
  return entries.find((e) => e.key === key)?.value;
}

/** Set or remove a metadata entry by key. Returns a new array. */
function setMetaEntry(entries: MetadataEntry[], key: string, value: string | undefined, type: MetadataEntry['type'] = 'string'): MetadataEntry[] {
  const filtered = entries.filter((e) => e.key !== key);
  if (value === undefined || value === '') return filtered;
  return [...filtered, { key, value, type }];
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
            className="h-4 w-4 text-blue-600 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
          />
          <label htmlFor="defaultsEnabled" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
            Configure pipeline-level CodeBuild defaults
          </label>
        </div>

        {defaults.enabled && (
          <div className="space-y-4 pl-4 border-l-2 border-blue-200 dark:border-blue-800">
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

            {/* Docker */}
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={getMetaValue(defaults.metadata, 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth') === 'true'}
                  onChange={(e) => onMetadataChange(
                    setMetaEntry(defaults.metadata, 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth', e.target.checked ? 'true' : undefined, 'boolean'),
                  )}
                  disabled={disabled}
                  className="rounded"
                />
                Enable Docker for synth step
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={getMetaValue(defaults.metadata, 'aws:cdk:codebuild:buildenvironment:privileged') === 'true'}
                  onChange={(e) => onMetadataChange(
                    setMetaEntry(defaults.metadata, 'aws:cdk:codebuild:buildenvironment:privileged', e.target.checked ? 'true' : undefined, 'boolean'),
                  )}
                  disabled={disabled}
                  className="rounded"
                />
                Enable privileged mode (required for Docker builds)
              </label>
            </div>

            {/* Notifications */}
            <div className="space-y-3">
              <label className="label">SNS Topic ARN (optional)</label>
              <input
                type="text"
                className="input"
                placeholder="arn:aws:sns:us-east-1:123456789012:my-topic"
                value={getMetaValue(defaults.metadata, 'aws:cdk:notifications:topic:arn') || ''}
                onChange={(e) => onMetadataChange(
                  setMetaEntry(defaults.metadata, 'aws:cdk:notifications:topic:arn', e.target.value || undefined),
                )}
                disabled={disabled}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Receive pipeline execution notifications via SNS (FAILED + SUCCEEDED events).
              </p>
            </div>

            {/* Operations */}
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={getMetaValue(defaults.metadata, 'aws:cdk:operations:executionevents') === 'true'}
                  onChange={(e) => onMetadataChange(
                    setMetaEntry(defaults.metadata, 'aws:cdk:operations:executionevents', e.target.checked ? 'true' : undefined, 'boolean'),
                  )}
                  disabled={disabled}
                  className="rounded"
                />
                Track pipeline execution events (EventBridge)
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={getMetaValue(defaults.metadata, 'aws:cdk:operations:metrics') === 'true'}
                  onChange={(e) => onMetadataChange(
                    setMetaEntry(defaults.metadata, 'aws:cdk:operations:metrics', e.target.checked ? 'true' : undefined, 'boolean'),
                  )}
                  disabled={disabled}
                  className="rounded"
                />
                Enable CloudWatch failure alarms
              </label>
            </div>

            {/* Encryption */}
            <div className="space-y-2">
              <label className="label">KMS Key ARN (optional)</label>
              <input
                type="text"
                className="input"
                placeholder="arn:aws:kms:us-east-1:123456789012:key/..."
                value={getMetaValue(defaults.metadata, 'aws:cdk:encryption:kmskeyarn') || ''}
                onChange={(e) => onMetadataChange(
                  setMetaEntry(defaults.metadata, 'aws:cdk:encryption:kmskeyarn', e.target.value || undefined),
                )}
                disabled={disabled}
              />
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
