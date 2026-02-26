import { ReactNode } from 'react';
import { FormField } from '@/components/ui/FormField';

/** Props for {@link PipelineConfigSection}. */
interface PipelineConfigSectionProps {
  /** Project identifier value. */
  project: string;
  /** Organization identifier value. */
  organization: string;
  /** Pipeline name value (auto-generated or manually overridden). */
  pipelineName: string;
  /** Optional description text (only shown when onDescriptionChange is provided). */
  description?: string;
  /** Optional comma-separated keywords (only shown when onKeywordsChange is provided). */
  keywords?: string;
  /** Callback when the project field changes. */
  onProjectChange: (val: string) => void;
  /** Callback when the organization field changes. */
  onOrganizationChange: (val: string) => void;
  /** Callback when the pipeline name field changes. */
  onPipelineNameChange: (val: string) => void;
  /** Callback when the description field changes (presence also controls field visibility). */
  onDescriptionChange?: (val: string) => void;
  /** Callback when the keywords field changes (presence also controls field visibility). */
  onKeywordsChange?: (val: string) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Validation errors keyed by field name (e.g. 'project', 'organization'). */
  errors?: Record<string, string>;
  /** Additional content rendered below the core fields (e.g. global metadata, defaults, role). */
  children?: ReactNode;
}

/**
 * Section for the core pipeline identity fields: project, organization,
 * pipeline name, and optionally description and keywords.
 *
 * The pipeline name field auto-generates a placeholder from organization + project.
 * Accepts children for rendering additional sub-sections within this configuration block.
 */
export default function PipelineConfigSection({
  project, organization, pipelineName, description, keywords,
  onProjectChange, onOrganizationChange, onPipelineNameChange, onDescriptionChange, onKeywordsChange,
  disabled, errors = {}, children,
}: PipelineConfigSectionProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide">
        Pipeline Configuration
      </h3>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Project *" error={errors['project']}>
          <input
            type="text"
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
            placeholder="my-project"
            disabled={disabled}
            className="input"
          />
        </FormField>
        <FormField label="Organization *" error={errors['organization']}>
          <input
            type="text"
            value={organization}
            onChange={(e) => onOrganizationChange(e.target.value)}
            placeholder="my-org"
            disabled={disabled}
            className="input"
          />
        </FormField>
      </div>

      {onDescriptionChange && (
        <FormField label="Description">
          <textarea
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            rows={2}
            placeholder="Brief description of this pipeline"
            disabled={disabled}
            className="input"
          />
        </FormField>
      )}

      {onKeywordsChange && (
        <FormField label="Keywords (comma-separated)">
          <input
            type="text"
            value={keywords}
            onChange={(e) => onKeywordsChange(e.target.value)}
            placeholder="keyword1, keyword2, keyword3"
            disabled={disabled}
            className="input"
          />
        </FormField>
      )}

      <FormField label="Pipeline Name" hint="Auto-generated when project or organization changes. Can be overridden.">
        <input
          type="text"
          value={pipelineName}
          onChange={(e) => onPipelineNameChange(e.target.value)}
          placeholder={project && organization ? `${organization}-${project}-pipeline` : 'Auto-generated from organization + project'}
          disabled={disabled}
          className="input"
        />
      </FormField>

      {children && (
        <div className="space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
