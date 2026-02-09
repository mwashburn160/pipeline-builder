import { FormBuilderState, FormNetworkConfig, FormPluginOptions, MetadataEntry } from '@/types/form-types';
import SourceTypeEditor from '../editors/SourceTypeEditor';
import PluginOptionsEditor from '../editors/PluginOptionsEditor';
import NetworkConfigEditor from '../editors/NetworkConfigEditor';
import MetadataEditor from '../editors/MetadataEditor';
import CollapsibleSection from '../editors/CollapsibleSection';

interface SynthSectionProps {
  synth: FormBuilderState['synth'];
  onSourceTypeChange: (type: FormBuilderState['synth']['sourceType']) => void;
  onS3Change: (field: string, value: string) => void;
  onGithubChange: (field: string, value: string) => void;
  onCodestarChange: (field: string, value: string | boolean) => void;
  onPluginChange: (plugin: FormPluginOptions) => void;
  onMetadataChange: (metadata: MetadataEntry[]) => void;
  onNetworkTypeChange: (type: FormBuilderState['synth']['networkType']) => void;
  onNetworkChange: (network: FormNetworkConfig) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

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
