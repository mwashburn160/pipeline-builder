import { ReactNode } from 'react';

interface PipelineConfigSectionProps {
  project: string;
  organization: string;
  pipelineName: string;
  description: string;
  keywords: string;
  onProjectChange: (val: string) => void;
  onOrganizationChange: (val: string) => void;
  onPipelineNameChange: (val: string) => void;
  onDescriptionChange: (val: string) => void;
  onKeywordsChange: (val: string) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
  children?: ReactNode;
}

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
        <div>
          <label className="label">Project *</label>
          <input
            type="text"
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
            placeholder="my-project"
            disabled={disabled}
            className="input"
          />
          {errors['project'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['project']}</p>}
        </div>
        <div>
          <label className="label">Organization *</label>
          <input
            type="text"
            value={organization}
            onChange={(e) => onOrganizationChange(e.target.value)}
            placeholder="my-org"
            disabled={disabled}
            className="input"
          />
          {errors['organization'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['organization']}</p>}
        </div>
      </div>

      <div>
        <label className="label">Description</label>
        <textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={2}
          placeholder="Brief description of this pipeline"
          disabled={disabled}
          className="input"
        />
      </div>

      <div>
        <label className="label">Keywords (comma-separated)</label>
        <input
          type="text"
          value={keywords}
          onChange={(e) => onKeywordsChange(e.target.value)}
          placeholder="keyword1, keyword2, keyword3"
          disabled={disabled}
          className="input"
        />
      </div>

      <div>
        <label className="label">Pipeline Name</label>
        <input
          type="text"
          value={pipelineName}
          onChange={(e) => onPipelineNameChange(e.target.value)}
          placeholder={project && organization ? `${organization}-${project}-pipeline` : 'Auto-generated from organization + project'}
          disabled={disabled}
          className="input"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Auto-generated when project or organization changes. Can be overridden.</p>
      </div>

      {children && (
        <div className="space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
