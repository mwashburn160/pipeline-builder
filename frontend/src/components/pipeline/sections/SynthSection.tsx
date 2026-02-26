import { FormBuilderState, FormNetworkConfig, FormPluginOptions, MetadataEntry } from '@/types/form-types';
import SourceTypeEditor from '../editors/SourceTypeEditor';
import PluginOptionsEditor from '../editors/PluginOptionsEditor';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import MetadataEditor from '../editors/MetadataEditor';
import CollapsibleSection from '../editors/CollapsibleSection';

/** Props for {@link SynthSection}. */
interface SynthSectionProps {
  /** Current synth configuration state (source, plugin, metadata, network). */
  synth: FormBuilderState['synth'];
  /** Callback when the source type selector changes. */
  onSourceTypeChange: (type: FormBuilderState['synth']['sourceType']) => void;
  /** Callback when an S3 source field changes. */
  onS3Change: (field: string, value: string) => void;
  /** Callback when a GitHub source field changes. */
  onGithubChange: (field: string, value: string) => void;
  /** Callback when a CodeStar source field changes. */
  onCodestarChange: (field: string, value: string | boolean) => void;
  /** Callback when the synth plugin configuration changes. */
  onPluginChange: (plugin: FormPluginOptions) => void;
  /** Callback when the synth metadata entries change. */
  onMetadataChange: (metadata: MetadataEntry[]) => void;
  /** Callback when the synth network type selector changes. */
  onNetworkTypeChange: (type: FormBuilderState['synth']['networkType']) => void;
  /** Callback when any synth network configuration field changes. */
  onNetworkChange: (network: FormNetworkConfig) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Validation errors keyed by field path. */
  errors?: Record<string, string>;
}

/**
 * Section for configuring the CDK synth step of the pipeline.
 *
 * Combines the source type editor (GitHub/S3/CodeStar), plugin options editor,
 * and collapsible sub-sections for synth-level metadata and network configuration.
 * This section is shown as step 2 in wizard mode.
 */
export default function SynthSection({
  synth,
  onSourceTypeChange, onS3Change, onGithubChange, onCodestarChange,
  onPluginChange, onMetadataChange, onNetworkTypeChange, onNetworkChange,
  disabled, errors = {},
}: SynthSectionProps) {
  const hasContent = synth.sourceType !== 's3' || synth.plugin.name !== '' ||
    synth.metadata.length > 0 || synth.networkType !== 'none';

  return (
    <CollapsibleSection title="Synthesis Configuration" defaultOpen={true} hasContent={hasContent}>
      <div className="mt-3 space-y-4">
        <SourceTypeEditor
          sourceType={synth.sourceType}
          s3={synth.s3}
          github={synth.github}
          codestar={synth.codestar}
          onSourceTypeChange={onSourceTypeChange}
          onS3Change={onS3Change}
          onGithubChange={onGithubChange}
          onCodestarChange={onCodestarChange}
          disabled={disabled}
          errors={errors}
        />

        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <PluginOptionsEditor
            value={synth.plugin}
            onChange={onPluginChange}
            disabled={disabled}
            error={errors['synth.plugin.name']}
            label="Plugin"
          />
        </div>

        <CollapsibleSection title="Synth Metadata" hasContent={synth.metadata.length > 0}>
          <div className="mt-3">
            <MetadataEditor
              value={synth.metadata}
              onChange={onMetadataChange}
              disabled={disabled}
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Synth Network" hasContent={synth.networkType !== 'none'}>
          <div className="mt-3">
            <NetworkConfigEditor
              networkType={synth.networkType}
              network={synth.network}
              onTypeChange={onNetworkTypeChange}
              onNetworkChange={onNetworkChange}
              disabled={disabled}
            />
          </div>
        </CollapsibleSection>
      </div>
    </CollapsibleSection>
  );
}
